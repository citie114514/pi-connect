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
    this.region = region;
    this.logger = logger;
    this.catalog = new TraeCatalog(region);
    this.identity = async () => {
      const store = this.store;
      const hint = region === "ai" ? "solo-sg" : "cn";
      try {
        const credential = await store.resolve();
        const candidates = store.candidates();
        return await resolveTraeIdentity(
          candidates.filter((c) => c.edition === credential.edition),
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
  async ensureReady() {
    const shim = await this.ensureShim();
    // One discovery at a time. A caller arriving mid-flight joins the run that
    // is already going instead of paying for a second one, which also means
    // there is only ever one result landing — "whoever finishes last wins"
    // stops being a race.
    if (this.modelsReady === false && this.modelsPending === undefined) {
      const flight = this.discoverModels()
        .then((models) => {
          if (models.length > 0) {
            this.catalog.set(deriveCatalog(sanitizeCatalog(models), new Set(), {}));
            // Only a success moves the clock forward: an empty discovery must
            // let the next request retry rather than sit on it for 30 minutes.
            this.modelsDiscoveredAt = Date.now();
            this.modelsReady = true;
          }
          return true;
        })
        .catch((error) => {
          this.logger?.warn?.(`trae: model directory discovery failed for ${this.region}`, error);
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
   * Re-discover the model directory when it has gone stale.
   *
   * Called once per request from the shim, the way the Pi port refreshes from
   * `auth.apiKey.resolve()`. TTL-gated, so inside the window this is a no-op and
   * costs nothing. On failure `modelsDiscoveredAt` is left alone, so the next
   * request retries — same "keep the last good directory" behaviour as the
   * Qoder side.
   *
   * `force` skips the TTL check so the panel's explicit "refresh" button can
   * pick up new models inside the 30-minute window.
   *
   * @returns the shim when a discovery ran, or `null` when this was a no-op.
   */
  async refreshCatalog({ force = false } = {}) {
    // A discovery is already running: join it rather than starting a second
    // one. This matters most on the first request after start-up, when
    // `modelsDiscoveredAt` is still 0 and every concurrent caller would
    // otherwise look stale and fire its own fetch.
    if (this.modelsPending !== undefined) return this.modelsPending;
    // Fresh: nothing to do. Checked after the in-flight case so a run that has
    // already landed is never mistaken for one still owed.
    if (!force && this.modelsReady && Date.now() - this.modelsDiscoveredAt < CATALOG_TTL_MS) return null;
    // Stale, or never discovered. Drop the completed memo so `ensureReady`
    // rediscovers; nothing is in flight, so this cannot orphan a promise.
    this.modelsReady = false;
    return this.ensureReady();
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
   * skeleton + wire config names), then rebuild the callable-key maps.
   */
  async discoverModels(signal) {
    const [remote, solo] = await Promise.all([
      this.remoteCatalog.fetchModels(signal).catch(() => []),
      this.upstream.fetchModels(signal).catch(() => []),
    ]);
    const merged = mergeTraeModelSources(remote, solo);
    this.wire.callableKeys.clear();
    for (const model of merged) {
      this.wire.callableKeys.add(model.id.trim().toLowerCase());
      this.wire.callableKeys.add(model.name.trim().toLowerCase());
    }
    this.wire.resolved = merged.length > 0;
    this.wire.byId.clear();
    this.wire.byName.clear();
    for (const model of merged) {
      if (model.wireConfigName !== undefined) {
        const target = { configName: model.wireConfigName, ...(model.wireFunction === undefined ? {} : { function: model.wireFunction }) };
        this.wire.byId.set(model.id, target);
        this.wire.byName.set(model.name.trim().toLowerCase(), target);
      }
    }
    return merged;
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
