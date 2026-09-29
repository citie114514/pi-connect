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

/**
 * One region's stack: credential store, catalog, shim, upstream bridge.
 */
class RegionStack {
  constructor(region, logger) {
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
    });
    return this.shim;
  }

  /** Start the shim (if needed) and wait until it is listening. */
  async ensureShim() {
    const shim = this.startShim();
    await shim.ready;
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
    if (this.modelsReady === undefined) {
      this.modelsReady = this.discoverModels()
        .then((models) => {
          if (models.length > 0) {
            this.catalog.set(deriveCatalog(sanitizeCatalog(models), new Set(), {}));
          }
          return true;
        })
        .catch((error) => {
          this.logger?.warn?.(`trae: model directory discovery failed for ${this.region}`, error);
          this.modelsReady = undefined;
          return false;
        });
    }
    await this.modelsReady;
    return shim;
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
export async function createTraeStacks({ cacheRoot, logger }) {
  if (cacheRoot !== undefined) setTraeOwnDir(cacheRoot);
  const stacks = [];
  for (const region of REGION_KEYS) {
    const stack = new RegionStack(region, logger, cacheRoot);
    stack.catalog.set(fallbackModelsFor(region));
    stacks.push(stack);
  }
  return stacks;
}

export { RegionStack, REGION_KEYS };
