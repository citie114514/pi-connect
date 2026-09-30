/**
 * Qoder region runtime — the host-agnostic half of the Pi port.
 *
 * Ported from the DeepSeek Harness plugin `@eghrhegpe/dsh-connect-qoder`. This
 * module owns everything that is not tied to a host: the credential cache, the
 * catalog store, the loopback shim, and their lifecycle.
 *
 * It deliberately registers nothing. The Pi port layers a
 * `pi.registerProvider` on top of it (`pi-connect-qoder/index.js`); the Cyrene
 * plugin only needs the runtime objects themselves and gets them from
 * `createQoderRuntimes`, which is defined at the bottom of this file.
 *
 * The protocol modules under `./lib` are reused unchanged from the DSH plugin.
 * See THIRD_PARTY_NOTICES.md in the plugin directory for attribution.
 *
 * @module ide-account-bridge/qoder-runtime
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { REGIONS, loadCredential, loadEnvCredential, sweepStaleOscryptDirs, setCredentialDiagnosticSink } from "./lib/credentials.js";
import { CredentialCache } from "./lib/credential-cache.js";
import { createQoderShim } from "./lib/shim.js";
import { CatalogStore } from "./lib/catalog-store.js";
import { normalizeEntry, filterByEnabled } from "./lib/catalog-entry.js";
import { toPiModel } from "./lib/pi-model.js";
import { exchangePat, fetchModels } from "./lib/upstream.js";
import { isCredentialUsable } from "./lib/credentials.js";
import { unwrapVolatile } from "./lib/volatile.js";
import { enabledIdsFor, imageModeFor, preferMaximumContext, regionEnabledFor, resolvePreferences } from "./lib/preferences.js";
import { registerQoderCommands } from "./commands.js";

/** Provider ids this extension owns. */
export const PROVIDER_IDS = ["qoder-cn", "qoder"];

/**
 * One region's runtime: credential cache + catalog + shim + provider state.
 */
class RegionRuntime {
  constructor(region, logger, cacheRoot, endpoints, portIndex = 0) {
    this.region = region;
    this.logger = logger;
    this.cacheRoot = cacheRoot;
    // Optional: when absent the shim keeps its original random-per-process
    // behaviour, which is what the Pi port relies on.
    this.endpoints = endpoints;
    this.portIndex = portIndex;
    this.credentials = new CredentialCache({
      loadApp: () => loadCredential(region, process.env.APPDATA ?? ""),
      loadEnv: () => loadEnvCredential(region),
      exchangePat: async (credential) => exchangePat(region, credential.token),
    });
    this.catalog = new CatalogStore({
      path: join(cacheRoot, `.qoder-catalog.${region.id}.json`),
      logger,
    });
    this.shim = undefined;
    this.disposed = false;
  }

  /** Start the loopback shim; called only when a session or a request needs it. */
  startShim() {
    if (this.shim !== undefined) return this.shim;
    this.shim = createQoderShim({
      region: this.region,
      resolveCredential: () => this.resolveCredential(),
      resolveModels: () => this.catalog.current(),
      resolveUpstreamKey: (id) => this.upstreamKey(id),
      resolveAlwaysThinking: (id) => this.entryFor(id)?.alwaysThinking === true,
      resolveEnabledIds: () => [],
      invalidateCredential: () => this.credentials.invalidate(),
      logger: this.logger,
      ...this.endpoints === undefined
        ? {}
        : {
            secret: this.endpoints.tokenFor(this.region.id),
            preferredPort: this.endpoints.preferredPortFor(this.region.id, this.portIndex),
          },
    });
    return this.shim;
  }

  /** Start the shim (if needed) and wait until it is listening. */
  async ensureShim() {
    const shim = this.startShim();
    await shim.ready;
    if (this.endpoints !== undefined) {
      // Read the address only after `ready`: before the listener is up,
      // `server.address()` is null and `baseUrl()` throws.
      const port = Number(new URL(shim.baseUrl()).port);
      if (Number.isInteger(port) && port > 0) this.endpoints.recordPort(this.region.id, port);
    }
    return shim;
  }

  /**
   * The loopback base URL when the shim is running, or a placeholder.
   *
   * Pi's extension contract forbids starting sockets in the factory, so a
   * model list may be built before the shim exists. The placeholder is only
   * ever a display value: the authoritative base URL travels with
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

  async resolveCredential() {
    return this.credentials.resolve();
  }

  upstreamKey(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId)?.key;
  }

  entryFor(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId);
  }

  /** Fetch a fresh catalog and keep the last good one on failure. */
  async refreshCatalog(signal) {
    if (this.catalog.fresh()) return;
    const credential = await this.resolveCredential();
    if (credential === undefined) return;
    try {
      const raw = await fetchModels(this.region, credential, signal);
      const entries = raw.map(normalizeEntry);
      if (entries.length > 0) this.catalog.replace(entries);
    } catch (error) {
      this.logger?.warn?.(
        `dsh-connect-qoder[pi]: ${this.region.displayName} catalog refresh failed; serving cached catalog`,
        error,
      );
    }
  }

  async close() {
    this.disposed = true;
    if (this.shim !== undefined) await this.shim.close();
  }
}

/**
 * Create one runtime per Qoder region for the Cyrene host.
 *
 * Unlike the Pi port — whose extension contract forbids opening sockets during
 * activation — the shim is started eagerly here: the panel has to show a live
 * base URL the moment the user opens it, so deferring to the first request
 * would leave an empty panel until something else happened to trigger one.
 */
export async function createQoderRuntimes({ cacheRoot, logger, endpoints }) {
  setCredentialDiagnosticSink((message) => logger.warn(message));
  try {
    sweepStaleOscryptDirs();
  } catch {
    // Housekeeping only; never blocks startup.
  }
  return REGIONS.map((region, index) => new RegionRuntime(region, logger, cacheRoot, endpoints, index));
}

export { RegionRuntime, REGIONS };
