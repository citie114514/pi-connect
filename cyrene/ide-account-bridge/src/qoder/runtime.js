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
 * After a failed catalog fetch, wait this long before another request-path
 * attempt. Failures do not block the request (the cached catalog serves it),
 * so without a backoff every request would re-fire the fetch against a
 * struggling gateway. A forced refresh (the panel's button) skips the backoff.
 */
const CATALOG_RETRY_AFTER_FAILURE_MS = 60 * 1000;

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
    /**
     * The catalog refresh currently in the air, shared by callers that arrive
     * while it runs. Cleared by the flight that still owns the slot.
     */
    this.catalogPending = undefined;
    /** When the last catalog fetch failed; drives the retry backoff. */
    this.catalogFailedAt = 0;
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
      // Lets a request refresh the directory, mirroring what the Pi port does
      // from `auth.apiKey.resolve()`. TTL-gated inside `refreshCatalog`.
      refreshCatalog: () => this.refreshCatalog(),
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

  /**
   * Fetch a fresh catalog and keep the last good one on failure.
   *
   * Single-flight. An empty catalog or an expired TTL used to make every
   * concurrent caller run its own `fetchModels`, and the two results raced:
   * the fetch that *started* first could *finish* last and overwrite the newer
   * directory, which was then re-cached for another 30 minutes. Reusing the
   * in-flight promise removes the race by construction — there is only ever
   * one result to land.
   *
   * The signal is honoured only by the flight that creates the slot. A caller
   * that joins mid-flight is waiting on someone else's fetch and has no claim
   * on its cancellation; letting a joiner abort it would turn one caller's
   * timeout into everyone's. In practice the creator is either the warm-up
   * (which passes `ctx.signal` + `WARM_TIMEOUT_MS`) or the request path (which
   * passes nothing, and `fetchModels` then applies its own 30s ceiling).
   *
   * `force` skips the TTL check so the panel's explicit "refresh" button can
   * pick up new models inside the 30-minute window, and the 60-second failure
   * backoff. An in-flight fetch is still shared: it is already asking upstream,
   * so a second one would only duplicate the call.
   */
  async refreshCatalog(signal, { force = false } = {}) {
    // Checked before freshness: a run already in the air has not landed yet, so
    // its caller must join it rather than be told "already fresh".
    if (this.catalogPending !== undefined) return this.catalogPending;
    if (!force && this.catalog.fresh()) return;
    // The last good catalog serves the request, so a fetch that just failed
    // must not be retried on every subsequent request.
    if (!force && Date.now() - this.catalogFailedAt < CATALOG_RETRY_AFTER_FAILURE_MS) return;
    const flight = this.fetchCatalog(signal).finally(() => {
      // Only the flight that still owns the slot may release it, so a late
      // finisher cannot clear a newer run's promise.
      if (this.catalogPending === flight) this.catalogPending = undefined;
    });
    this.catalogPending = flight;
    return flight;
  }

  /** One catalog fetch. Split out so `refreshCatalog` owns only the slot. */
  async fetchCatalog(signal) {
    // Drop the cached desktop credential before reading: the cache reuses any
    // credential whose `expired` flag is false, so a user who switched Qoder
    // accounts in the desktop app would keep being billed on the old account
    // until its token died. A catalog refresh is the natural re-read point —
    // it runs at most every 30 minutes (plus the panel's forced refresh), so
    // the extra DPAPI subprocess it costs is not on the request path.
    this.credentials.invalidate();
    const credential = await this.resolveCredential();
    if (credential === undefined) return;
    try {
      const raw = await fetchModels(this.region, credential, signal);
      const entries = raw.map(normalizeEntry);
      if (entries.length > 0) this.catalog.replace(entries);
      this.catalogFailedAt = 0;
    } catch (error) {
      this.catalogFailedAt = Date.now();
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
