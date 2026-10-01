/**
 * DSH Connect Trae — Pi extension.
 *
 * Port of the DeepSeek Harness plugin `dsh-connect-trae` for the Pi coding
 * agent. Reuses the plugin's protocol core (`lib/trae-core.js`, surgically
 * extracted from the DSH bundle) unchanged: credential store, token refresh,
 * device identity, loopback shim, SOLO upstream, remote catalog, SSE bridge.
 *
 * Registers two native Pi providers, mirroring the DSH bundle's two routes:
 *   - `trae`        (domestic / CN gateway)
 *   - `trae-global` (international / trae.ai gateway)
 *
 * Each provider routes through its region's loopback shim exactly as in DSH:
 * the shim speaks OpenAI on 127.0.0.1 and the verified Trae SOLO protocol on
 * the way out. The shim token is the only credential Pi ever sees.
 *
 * @module dsh-connect-trae-pi
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
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

/** Where the plugin-owned refreshed credential copies live inside the Pi agent dir. */
function piOwnDir() {
  return join(homedir(), ".pi", "agent", "cache", "dsh-connect-trae");
}

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
 * Build the native Pi provider for one region.
 *
 * Models are mapped from the region's catalog to pi-ai descriptors whose
 * baseUrl points at the loopback shim; Pi's openAI-completions API then routes
 * requests through it, exactly as DSH's PiAiAdapter did.
 */
function createTraePiProvider(stack, logger) {
  const region = stack.region;
  const providerId = TRAE_PROVIDERS[region];
  const displayName = TRAE_PROVIDER_DISPLAY_NAMES[region];

  const buildModels = () => {
    const baseUrl = stack.baseUrlOrPlaceholder();
    return stack.catalog.current().map((info) => {
      // Pi has no per-model context budget card, so the DSH bundle's Max-window
      // selector is unreachable here and a row on its dev window would sit at
      // 200K/256K forever. Trae's live directory publishes both windows
      // (`context_window_tokens.dev` → `contextWindow`, `.max` →
      // `maxContextWindow`); advertise the model's own Max when it offers one,
      // and never invent a value for a model that does not.
      const contextWindow = info.maxContextWindow ?? info.contextWindow ?? 200000;
      return {
        id: info.id,
        name: traeModelDisplayName(info),
        api: "openai-completions",
        provider: providerId,
        baseUrl,
        input: traeInputModalities(info),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: info.reasoningEfforts !== undefined,
        ...(info.reasoningEfforts === undefined
          ? {}
          : {
              thinkingLevelMap: {
                off: null,
                minimal: null,
                low: info.reasoningEfforts.low ?? null,
                medium: null,
                high: info.reasoningEfforts.high ?? null,
                xhigh: info.reasoningEfforts.xhigh ?? null,
                max: null,
              },
            }),
        contextWindow,
        // Pi's `--list-models` renders maxTokens without an undefined guard,
        // and a declared value only bounds the thinking budget (pi-ai sends
        // `options.maxTokens`, never `model.maxTokens`, as the request
        // ceiling), so advertising the context window is display-safe and
        // never truncates — matching the DSH bundle's no-output-ceiling rule.
        maxTokens: info.maxTokens === undefined ? contextWindow : info.maxTokens,
        compat: { supportsReasoningEffort: info.reasoningEfforts !== undefined },
      };
    });
  };

  const provider = {
    id: providerId,
    name: displayName,
    baseUrl: undefined,
    auth: {
      apiKey: {
        name: `${displayName} loopback shim token`,
        async check() {
          try {
            const credential = await stack.store.resolve();
            if (credential === undefined) return undefined;
            if (regionOfCredential(credential) !== region) return undefined;
            return { type: "api_key", source: displayName };
          } catch {
            return undefined;
          }
        },
        async resolve({ credential }) {
          // Never start a socket for a region with no usable sign-in: the
          // runtime also calls `resolve` while probing whether to refresh, and
          // an unsigned region must stay completely inert.
          let appCredential;
          try {
            appCredential = await stack.store.resolve();
          } catch {
            return undefined;
          }
          if (appCredential === undefined || regionOfCredential(appCredential) !== region) return undefined;
          // The request path: start the shim on demand, make sure the wire map
          // is loaded, and hand Pi both the bearer token and the live base URL
          // (Pi overrides the model's baseUrl with this one before sending).
          const shim = await stack.ensureReady();
          const apiKey = credential?.key ?? shim.token();
          if (apiKey === undefined || apiKey.length === 0) return undefined;
          return { auth: { apiKey, baseUrl: `${shim.baseUrl()}/v1` }, source: displayName };
        },
      },
    },
    getModels: () => buildModels(),
    refreshModels: async (context) => {
      if (context.stored?.models?.length) {
        await context.publish({
          persist: { models: context.stored.models, checkedAt: context.stored.checkedAt },
          update: () => {},
        });
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      try {
        const models = await stack.discoverModels(context.signal);
        if (context.signal.aborted) return;
        stack.catalog.set(deriveCatalog(sanitizeCatalog(models), new Set(), {}));
        if (context.signal.aborted) return;
        const list = buildModels();
        await context.publish({
          persist: { models: list, checkedAt: Date.now() },
          update: () => {},
        });
      } catch (error) {
        logger.warn(`trae[pi]: live ${region} model directory unavailable; serving fallback catalog`, error);
        if (stack.catalog.current().length === 0) stack.catalog.set(fallbackModelsFor(region));
      }
    },
    stream: (model, context, options) => stream(model, context, options),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
  };
  return provider;
}

/** Pi extension factory. */
export default async function activate(pi) {
  const logger = {
    warn: (message, detail) => console.warn(`[dsh-connect-trae] ${message}`, detail ?? ""),
    info: (message) => console.info(`[dsh-connect-trae] ${message}`),
    error: (message, detail) => console.error(`[dsh-connect-trae] ${message}`, detail ?? ""),
  };

  const stacks = [];
  try {
    for (const region of REGION_KEYS) {
      // The factory registers the provider and seeds the static fallback
      // catalog only. Per Pi's extension contract it starts no socket here:
      // the shim is opened from `session_start` or on the first model request.
      const stack = new RegionStack(region, logger);
      stack.catalog.set(fallbackModelsFor(region));
      stacks.push(stack);
      pi.registerProvider(createTraePiProvider(stack, logger));
      logger.info(
        `registered provider ${TRAE_PROVIDERS[region]} (${TRAE_PROVIDER_DISPLAY_NAMES[region]}) with ${stack.catalog.current().length} fallback models`,
      );
    }
  } catch (error) {
    logger.error("activation failed; Trae models will be unavailable", error);
  }

  // Warm each region's shim once a session exists (and only then — a
  // session-less invocation such as `pi --list-models` must not open sockets).
  pi.on?.("session_start", async () => {
    for (const stack of stacks) {
      try {
        let credential;
        try {
          credential = await stack.store.resolve();
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("trae: no signed-in account")) continue;
          throw error;
        }
        if (credential === undefined) continue;
        await stack.ensureReady();
        logger.info(`ready: ${TRAE_PROVIDERS[stack.region]} (${stack.catalog.current().length} models)`);
      } catch (error) {
        logger.warn(`trae ${stack.region}: shim/catalog warm-up failed`, error);
      }
    }
  });

  // Daily check-in / usage, surfaced as Pi slash commands.
  registerTraeCommands(pi, stacks);

  pi.on?.("session_shutdown", () => {
    for (const stack of stacks) void stack.close();
  });
}
