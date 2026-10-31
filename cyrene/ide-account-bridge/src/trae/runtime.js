/**
 * Trae region runtime — the host-agnostic half of the Pi port.
 *
 * Ported from the DeepSeek Harness plugin `dsh-connect-trae`. Reuses that
 * plugin's protocol core (`./lib/trae-core.js`, surgically extracted from the
 * DSH bundle) unchanged: credential store, token refresh, device identity,
 * loopback shim, SOLO upstream, remote catalog, SSE bridge.
 *
 * One `RegionStack` per region — `cn` (domestic gateway) and `ai`
 * (international gateway) — created by `createTraeStacks` at the bottom of
 * this file. It registers nothing: the Pi port wraps each stack in a
 * `pi.registerProvider`, while the Cyrene plugin only needs the stack itself.
 *
 * @module ide-account-bridge/trae-runtime
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  TRAE_PROVIDERS,
  TRAE_PROVIDER_DISPLAY_NAMES,
  REGION_GATEWAYS,
  TraeCatalog,
  TraeCredentialStore,
  TraeDelegatingUpstreamClient,
  TraeSoloBridge,
  TraeSoloRemoteCatalogClient,
  TraeSoloUpstreamClient,
  createTraeShim,
  setTraeOwnDir,
  fallbackModelsFor,
  mergeTraeModelSources,
  refreshTraeCredential,
  regionOfCredential,
  resolveTraeIdentity,
  traeModelDisplayName,
  traeInputModalities,
  deriveCatalog,
  sanitizeCatalog,
  traeStorageCandidates,
} from "./lib/trae-core.js";
import { registerTraeCommands } from "./commands.js";

/** Every region, matching the DSH bundle's card tab order. */
const REGION_KEYS = ["cn", "ai"];

/** How long a discovered Trae model directory stays fresh before rediscovery. */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/**
 * After a failed discovery, wait this long before another request-path attempt.
 * Failures do not block the request any more (the cached directory serves it),
 * so without a backoff every request would re-fire the full per-function
 * discovery against a struggling upstream.
 */
const CATALOG_RETRY_AFTER_FAILURE_MS = 60 * 1000;

/**
 * One region's stack: credential store, catalog, shim, upstream bridge.
 */
class RegionStack {
  constructor(region, logger, cacheRoot, endpoints, portIndex = 0) {
    // `cacheRoot` is unused here (Trae keeps its own dir via `setTraeOwnDir`),
    // but the parameter is kept so the positional shape matches the factory.
    this.endpoints = endpoints;
    this.portIndex = portIndex;
    /** When the current model directory was discovered; 0 means never. */
    this.modelsDiscoveredAt = 0;
    /**
     * Whether a non-empty directory has been landed at least once.
     *
     * Deliberately separate from `modelsPending`: one flag answers "do we have
     * a directory", the other "is a fetch in the air". Collapsing both into a
     * single promise slot is what let a refresh clear a discovery that had not
     * landed yet, so the next request started a duplicate one.
     */
    this.modelsReady = false;
    /** The in-flight discovery, shared by callers that arrive during it. */
    this.modelsPending = undefined;
    /** When the last discovery attempt failed; drives the retry backoff. */
    this.modelsFailedAt = 0;
    this.region = region;
    this.logger = logger;
    this.catalog = new TraeCatalog(region);
    this.identity = async () => {
      const store = this.store;
      const hint = region === "ai" ? "solo-sg" : "cn";
      try {
        // Read the credential WITHOUT resolving it. `resolve()` may start a
        // token refresh, and that refresh callback (below) awaits `device()` →
        // `identity()` → back here: the re-entrant call returns the SAME
        // in-flight refresh promise, so the refresh can never settle and every
        // caller deadlocks. Observed on this machine 2026-10-31: an expired
        // Trae CN token hung warm-up past 120s and the panel never opened.
        // `current()` is a plain local read with no refresh.
        const credential = await store.current();
        const candidates = store.candidates();
        return await resolveTraeIdentity(
          credential === undefined
            ? []
            : candidates.filter((c) => c.edition === credential.edition),
          hint,
        );
      } catch {
        // Identity is best-effort; degrade to CLI identity.
        return resolveTraeIdentity([], hint).catch(() => undefined);
      }
    };
    this.store = new TraeCredentialStore({
      region,
      edition: "auto",
      refresh: async (credential) => refreshTraeCredential(credential, undefined, await this.device()),
    });
    this.upstream = new TraeSoloUpstreamClient({
      credential: () => this.store.resolve(),
      identity: this.identity,
      log: (message, detail) => this.logger.warn(message, detail),
    });
    this.remoteCatalog = new TraeSoloRemoteCatalogClient({
      credential: () => this.store.resolve(),
    });
    this.wire = { byId: new Map(), byName: new Map(), callableKeys: new Set(), resolved: false };
    this.wireResolver = (displayId) =>
      this.wire.byId.get(displayId) ?? this.wire.byName.get(String(displayId ?? "").trim().toLowerCase());
    const bridge = new TraeSoloBridge(this.upstream, this.catalog, this.wireResolver);
    this.delegating = new TraeDelegatingUpstreamClient(bridge);
    this.shim = undefined;
  }

  /**
   * Create the loopback shim on demand.
   *
   * Pi's extension contract forbids starting sockets in the factory, so the
   * shim is created from `session_start` (warm-up) or from
   * `auth.apiKey.resolve` on the first model request.
   */
  startShim() {
    if (this.shim !== undefined) return this.shim;
    this.shim = createTraeShim({
      catalog: this.catalog,
      client: this.delegating,
      logger: this.logger,
      // Lets a request refresh the directory, mirroring what the Pi port does
      // from `auth.apiKey.resolve()`.
      refreshCatalog: () => this.refreshCatalog(),
      // Absent on the Pi port, which keeps its original random-per-process
      // behaviour.
      ...this.endpoints === undefined
        ? {}
        : {
            secret: this.endpoints.tokenFor(this.region),
            preferredPort: this.endpoints.preferredPortFor(this.region, this.portIndex),
          },
    });
    return this.shim;
  }

  /** Start the shim (if needed) and wait until it is listening. */
  async ensureShim() {
    const shim = this.startShim();
    await shim.ready;
    if (this.endpoints !== undefined) {
      // Record what actually bound: a taken preferred port falls back to a
      // random one, and the next start should prefer that instead.
      const port = Number(new URL(shim.baseUrl()).port);
      if (Number.isInteger(port) && port > 0) this.endpoints.recordPort(this.region, port);
    }
    return shim;
  }

  /**
   * Make the region ready to serve a request: shim listening + the wire map
   * (model id → Trae `config_name`/function) discovered at least once.
   *
   * The bridge needs the wire map to translate a model id into a callable
   * `config_name`; with an empty map it would forward the display id and the
   * upstream answers `4001 param is invalid`. Discovery is cached after the
   * first success, and a failure resets the cache so the next request retries.
   */
  async ensureReady({ rediscover = false, signal } = {}) {
    const shim = await this.ensureShim();
    // One discovery at a time. A caller arriving mid-flight joins the run that
    // is already going instead of paying for a second one, which also means
    // there is only ever one result landing — "whoever finishes last wins"
    // stops being a race.
    if ((this.modelsReady === false || rediscover) && this.modelsPending === undefined) {
      const flight = this.discoverModels(signal)
        .then((outcome) => {
          // Nothing usable came back. This is a failure for scheduling
          // purposes — record it so the backoff applies — but it is NOT a
          // reason to discard what we already have: `discoverModels` leaves
          // the previous catalog and wire map untouched on this path.
          if (outcome.models.length === 0) {
            this.modelsFailedAt = Date.now();
            this.logger?.warn?.(
              `trae: model directory unavailable for ${this.region}; keeping the previous directory`,
              outcome.failures,
            );
            return false;
          }
          // Only a full, non-empty answer replaces the directory. A partial one
          // is still applied (those models are callable), but the timestamp is
          // deliberately not advanced, so the next request retries and can pick
          // up the models the failed function serves.
          this.applyDirectory(outcome.models, outcome.wire);
          if (outcome.complete) {
            this.modelsDiscoveredAt = Date.now();
            this.modelsFailedAt = 0;
            this.modelsReady = true;
          } else {
            this.modelsFailedAt = Date.now();
            this.logger?.warn?.(
              `trae: model directory for ${this.region} is incomplete; serving it but retrying on the next request`,
              outcome.failures,
            );
          }
          return true;
        })
        .catch((error) => {
          // `discoverModels` reports upstream problems through `failures`
          // rather than by throwing, so this only catches a programming error.
          // The previous directory stays in place.
          this.logger?.warn?.(`trae: model directory discovery failed for ${this.region}`, error);
          this.modelsFailedAt = Date.now();
          return false;
        })
        .finally(() => {
          // Only the flight that still owns the slot may release it; a run
          // that finished late must not wipe a newer one's promise.
          if (this.modelsPending === flight) this.modelsPending = undefined;
        });
      this.modelsPending = flight;
    }
    if (this.modelsPending !== undefined) await this.modelsPending;
    return shim;
  }

  /**
   * Land a discovered directory: replace the catalog and the wire map together.
   *
   * Only ever called with a non-empty result, so a failed or empty discovery
   * can never clear the maps a live request depends on.
   */
  applyDirectory(models, wire) {
    this.catalog.set(deriveCatalog(sanitizeCatalog(models), new Set(), {}));
    this.wire.callableKeys.clear();
    for (const model of models) {
      this.wire.callableKeys.add(model.id.trim().toLowerCase());
      this.wire.callableKeys.add(model.name.trim().toLowerCase());
    }
    this.wire.byId.clear();
    this.wire.byName.clear();
    for (const [id, target] of wire) this.wire.byId.set(id, target);
    for (const [name, target] of wire) this.wire.byName.set(name, target);
    this.wire.resolved = true;
  }

  /**
   * Re-discover the model directory when it has gone stale.
   *
   * Called once per request from the shim, the way the Pi port refreshes from
   * `auth.apiKey.resolve()`. TTL-gated, so inside the window this is a no-op and
   * costs nothing. On failure `modelsDiscoveredAt` is left alone, so the next
   * request retries — same "keep the last good directory" behaviour as the
   * Qoder side.
   *
   * `force` skips the TTL check so the panel's explicit "refresh" button can
   * pick up new models inside the 30-minute window. `signal` bounds the
   * discovery for callers that must not wait forever (activation warm-up); it
   * belongs to the flight that created the slot, never to a joiner.
   *
   * @returns the shim when a discovery ran, or `null` when this was a no-op.
   */
  async refreshCatalog({ force = false, signal } = {}) {
    // A discovery is already running: join it rather than starting a second
    // one. This matters most on the first request after start-up, when
    // `modelsDiscoveredAt` is still 0 and every concurrent caller would
    // otherwise look stale and fire its own fetch.
    if (this.modelsPending !== undefined) return this.modelsPending;
    // Fresh: nothing to do. Checked after the in-flight case so a run that has
    // already landed is never mistaken for one still owed.
    if (!force && this.modelsReady && Date.now() - this.modelsDiscoveredAt < CATALOG_TTL_MS) return null;
    // A discovery just failed; the last good directory serves the request, so
    // do not hammer the upstream on every request. A forced refresh (the
    // panel's button) skips the backoff deliberately.
    if (!force && Date.now() - this.modelsFailedAt < CATALOG_RETRY_AFTER_FAILURE_MS) return null;
    // Ask `ensureReady` to rediscover without touching `modelsReady`: that flag
    // means "a directory has landed", and a failed refresh must not revoke it —
    // the previous directory is still serving requests.
    return this.ensureReady({ rediscover: true, signal });
  }

  /**
   * The loopback base URL when the shim is running, or a placeholder.
   *
   * The placeholder is display-only: the authoritative base URL travels with
   * `auth.apiKey.resolve`, and `ModelRuntime.prepareRequest` overwrites the
   * model's `baseUrl` from it before any request is sent.
   */
  baseUrlOrPlaceholder() {
    if (this.shim === undefined) return "http://127.0.0.1:0/v1";
    try {
      return `${this.shim.baseUrl()}/v1`;
    } catch {
      return "http://127.0.0.1:0/v1";
    }
  }

  async close() {
    if (this.shim !== undefined) await this.shim.close();
  }

  async device() {
    try {
      const identity = await this.identity();
      return { deviceId: identity.deviceId, machineId: identity.machineId };
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch the live model directory and merge the two Trae sources (remote
   * skeleton + wire config names).
   *
   * Returns an outcome instead of throwing, so the caller can tell "upstream is
   * down" from "the account has no models" without either one wiping the
   * directory it already serves:
   *
   * - `models` — the merged roster, empty when nothing could be discovered.
   * - `wire` — id/name → `config_name` mappings for those models.
   * - `complete` — every directory function and both sources answered. When
   *   false, the models are still usable, but a source is missing models, so
   *   the caller keeps retrying instead of caching the gap for 30 minutes.
   * - `failures` — one short string per failed source/function, for the log.
   *
   * Nothing here mutates the live catalog or wire map: only the caller does,
   * and only on a non-empty result.
   */
  async discoverModels(signal) {
    const [remoteResult, soloResult] = await Promise.all([
      this.remoteCatalog.fetchModels(signal).then(
        (models) => ({ models, failures: [] }),
        (error) => ({ models: [], failures: [`remote: ${String(error).slice(0, 120)}`] }),
      ),
      // The SOLO source exposes per-function failures alongside a partial
      // roster; `fetchModels` is the plain-array form for callers that do not
      // care. Fall back when an older extraction lacks the detailed variant.
      typeof this.upstream.fetchModelsDetailed === "function"
        ? this.upstream.fetchModelsDetailed(signal).then(
            (result) => ({ models: result.models, failures: result.failures ?? [] }),
            (error) => ({ models: [], failures: [`solo: ${String(error).slice(0, 120)}`] }),
          )
        : this.upstream.fetchModels(signal).then(
            (models) => ({ models, failures: [] }),
            (error) => ({ models: [], failures: [`solo: ${String(error).slice(0, 120)}`] }),
          ),
    ]);
    const failures = [...remoteResult.failures, ...soloResult.failures];
    // The remote directory is the merge skeleton, so losing it usually means an
    // empty merge even when SOLO answered fine. Falling back to the wire roster
    // keeps the region usable: those entries are exactly the models the bridge
    // can call, they just lack the remote skeleton's display extras.
    const merged = mergeTraeModelSources(remoteResult.models, soloResult.models);
    if (merged.length === 0 && soloResult.models.length > 0) {
      failures.push("remote: unavailable; serving the SOLO roster without the remote skeleton");
      for (const model of soloResult.models) {
        merged.push({
          id: model.id,
          name: model.name,
          input: ["text"],
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
          ...(model.id === "" ? {} : { wireConfigName: model.id }),
          ...(model.function === undefined ? {} : { wireFunction: model.function }),
        });
      }
    }
    const wire = new Map();
    for (const model of merged) {
      if (model.wireConfigName !== undefined) {
        wire.set(model.id, {
          configName: model.wireConfigName,
          ...(model.wireFunction === undefined ? {} : { function: model.wireFunction }),
        });
      }
    }
    return {
      models: merged,
      wire,
      complete: failures.length === 0,
      failures,
    };
  }
}

/**
 * Create one stack per Trae region for the Cyrene host, seeded with the static
 * fallback catalog.
 *
 * The shim is started eagerly (see `ensureReady`) rather than on the first
 * request, because the panel must show a usable base URL as soon as it opens.
 * A region with no signed-in account is skipped silently: it would only ever
 * answer 401 and would put a dead route in front of the user.
 */
export async function createTraeStacks({ cacheRoot, logger, endpoints }) {
  if (cacheRoot !== undefined) setTraeOwnDir(cacheRoot);
  const stacks = [];
  for (const [index, region] of REGION_KEYS.entries()) {
    const stack = new RegionStack(region, logger, cacheRoot, endpoints, index);
    stack.catalog.set(fallbackModelsFor(region));
    stacks.push(stack);
  }
  return stacks;
}

export { RegionStack, REGION_KEYS };
