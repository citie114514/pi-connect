/**
 * DSH Connect Qoder — Pi extension.
 *
 * Port of the DeepSeek Harness plugin `@eghrhegpe/dsh-connect-qoder` for the
 * Pi coding agent. It reuses the plugin's own protocol modules (credentials,
 * upstream COSY signing, loopback shim, catalog, pi-model mapping) unchanged
 * and registers one native Pi provider per Qoder region (`qoder-cn`, `qoder`)
 * exactly the way the DSH bundle registered DSH adapters.
 *
 * How the pieces fit Pi:
 *
 *  - `pi.registerProvider(provider)` registers a NATIVE provider object, the
 *    same surface the built-in llama.cpp extension uses. The provider owns its
 *    auth (`auth.apiKey.check`/`resolve`), its model list (`getModels`), its
 *    refresh hook (`refreshModels`) and its wire code (`stream`/`streamSimple`).
 *  - The loopback shim (`lib/shim.js`) speaks OpenAI on 127.0.0.1 and COSY-
 *    signed Qoder on the way out, exactly as in DSH. Pi's openAI-completions
 *    API routes a request to a model's `baseUrl` — which points at the shim —
 *    and the shim answers with the Qoder result.
 *  - Auth: the shim requires a per-process random bearer token. The provider's
 *    `auth.apiKey.check` proves the region is signed in (so only signed-in
 *    regions appear in `pi --list-models`), and `auth.apiKey.resolve` hands
 *    Pi that token per request. No Qoder credential ever reaches Pi.
 *  - Catalog: `refreshModels(context)` fetches the live model directory via
 *    `lib/upstream.js` and publishes it through `context.publish`, mirroring
 *    the DSH bundle's CatalogStore (which is also kept, at a Pi-owned path).
 *
 * The Qoder apps' sign-in is read from the same local store as in DSH
 * (`%APPDATA%`, OSCrypt + DPAPI) — nothing here starts an OAuth flow and
 * nothing writes to the Qoder apps' files.
 *
 * @module dsh-connect-qoder-pi
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
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

/** Catalog cache root inside the Pi agent dir. */
function catalogRoot() {
  return join(homedir(), ".pi", "agent", "cache", "dsh-connect-qoder");
}

/**
 * One region's runtime: credential cache + catalog + shim + provider state.
 */
class RegionRuntime {
  constructor(region, logger) {
    this.region = region;
    this.logger = logger;
    this.credentials = new CredentialCache({
      loadApp: () => loadCredential(region, process.env.APPDATA ?? ""),
      loadEnv: () => loadEnvCredential(region),
      exchangePat: async (credential) => exchangePat(region, credential.token),
    });
    this.catalog = new CatalogStore({
      path: join(catalogRoot(), `.qoder-catalog.${region.id}.json`),
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
 * Build the native Pi provider for one region.
 *
 * The provider routes through the shim: every model's `baseUrl` is the
 * region's loopback endpoint, and the API key is the shim's bearer token.
 */
function createQoderPiProvider(runtime, logger) {
  const region = runtime.region;

  const buildModels = () => {
    if (regionEnabledFor({}, region.id) !== true) return [];
    const baseUrl = runtime.baseUrlOrPlaceholder();
    // Pi has no settings card, so the DSH bundle's `useMaximumContextWindow`
    // switch is unreachable here: `preferMaximumContext({})` always answered
    // false and pinned every row to Qoder's 200K catalog default. Seed the
    // preference on instead — Qoder's own client offers 200K/400K/1M for these
    // models and the gateway accepts the largest, so with no reachable switch
    // 1M is the window the account actually runs with.
    const widest = preferMaximumContext({ useMaximumContextWindow: true });
    const enabled = enabledIdsFor({}, region.id);
    return filterByEnabled(runtime.catalog.current(), enabled).map((entry) => {
      const model = toPiModel(entry, baseUrl, region.id, widest, imageModeFor({}, entry.id));
      // Pi's `--list-models` renders maxTokens without an undefined guard, and
      // a declared value only bounds the thinking budget (pi-ai sends
      // `options.maxTokens`, never `model.maxTokens`, as the request ceiling),
      // so advertising the full context window is display-safe and never
      // truncates — preserving the DSH bundle's "no output ceiling" decision.
      if (model.maxTokens === undefined) model.maxTokens = model.contextWindow;
      return model;
    });
  };

  const provider = {
    id: region.id,
    name: region.displayName,
    baseUrl: undefined,
    auth: {
      apiKey: {
        name: `${region.displayName} loopback shim token`,
        async check() {
          // A region is only offered when a usable sign-in exists. `check`
          // never starts the shim — it answers from the credential alone, so a
          // session-less invocation (e.g. `pi --list-models`) can list models
          // without opening a socket.
          const credential = await runtime.resolveCredential();
          if (!isCredentialUsable(credential)) return undefined;
          return { type: "api_key", source: region.displayName };
        },
        async resolve({ credential }) {
          // Never start a socket for a region with no usable sign-in: the
          // runtime also calls `resolve` while probing whether to refresh, and
          // an unsigned region must stay completely inert.
          const appCredential = await runtime.resolveCredential();
          if (!isCredentialUsable(appCredential)) return undefined;
          // The wire needs this model's upstream key, which lives in the
          // catalog; make sure one exists (a no-op while the catalog is fresh).
          await runtime.refreshCatalog();
          // The request path: start the shim on demand and hand Pi both the
          // bearer token and the live base URL (Pi overrides the model's
          // baseUrl with this one before sending).
          const shim = await runtime.ensureShim();
          const apiKey = credential?.key ?? shim.token();
          if (apiKey === undefined || apiKey.length === 0) return undefined;
          return { auth: { apiKey, baseUrl: `${shim.baseUrl()}/v1` }, source: region.displayName };
        },
      },
    },
    getModels: () => buildModels(),
    refreshModels: async (context) => {
      // Offline phase: keep whatever catalog Pi already has.
      if (context.stored?.models?.length) {
        await context.publish({
          persist: { models: context.stored.models, checkedAt: context.stored.checkedAt },
          update: () => {},
        });
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      await runtime.refreshCatalog(context.signal);
      if (context.signal.aborted) return;
      const models = buildModels();
      await context.publish({
        persist: { models, checkedAt: Date.now() },
        update: () => {},
      });
    },
    stream: (model, context, options) => stream(model, context, options),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
  };
  return provider;
}

/**
 * Pi extension factory. `pi` is the extension API; `ctx` is not used.
 */
export default async function activate(pi) {
  const logger = {
    warn: (message, detail) => console.warn(`[dsh-connect-qoder] ${message}`, detail ?? ""),
    info: (message) => console.info(`[dsh-connect-qoder] ${message}`),
    error: (message, detail) => console.error(`[dsh-connect-qoder] ${message}`, detail ?? ""),
  };
  setCredentialDiagnosticSink((message) => logger.warn(message));
  try {
    sweepStaleOscryptDirs();
  } catch {
    // Housekeeping only; never blocks startup.
  }

  const runtimes = [];
  try {
    for (const region of REGIONS) {
      // The factory registers the provider and reads nothing but the cached
      // catalog. Per Pi's extension contract it starts no socket here: the
      // shim is opened from `session_start` or on the first model request.
      const runtime = new RegionRuntime(region, logger);
      runtimes.push(runtime);
      pi.registerProvider(createQoderPiProvider(runtime, logger));
      logger.info(
        `registered provider ${region.id} (${region.displayName}) with ${runtime.catalog.current().length} cached models`,
      );
    }
  } catch (error) {
    logger.error("activation failed; Qoder models will be unavailable", error);
  }

  // Warm each region's shim once a session exists (and only then — a
  // session-less invocation such as `pi --list-models` must not open sockets).
  pi.on?.("session_start", async () => {
    for (const runtime of runtimes) {
      try {
        const credential = await runtime.resolveCredential();
        if (credential === undefined || credential.expired === true) continue;
        await runtime.ensureShim();
        await runtime.refreshCatalog();
        logger.info(`ready: ${runtime.region.id} (${runtime.catalog.current().length} models)`);
      } catch (error) {
        logger.warn(`${runtime.region.displayName}: shim/catalog warm-up failed`, error);
      }
    }
  });

  // Quota / daily check-in, surfaced as Pi slash commands.
  registerQoderCommands(pi, runtimes);

  // Close the loopback shims with the session that owns them.
  pi.on?.("session_shutdown", () => {
    for (const runtime of runtimes) void runtime.close();
  });
}
