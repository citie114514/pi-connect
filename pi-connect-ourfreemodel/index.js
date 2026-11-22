/**
 * Pi Connect Our Free Model — Pi extension.
 *
 * This package is a **thin adapter**, and that is the whole design. Our Free
 * Model (`dsh-our-free-model`) already ships a complete local OpenAI-compatible
 * service that owns:
 *
 *   - every account channel and its login flow (LobsterAI, Qoder, TRAE, Cline,
 *     Loomy, Raccoon, MiniMax, ZCode, Gemini),
 *   - the anonymous free pools,
 *   - the account pool, credit claiming and the quota ledger.
 *
 * Reimplementing any of that in Pi would fork the protocol work and drift from
 * upstream on the first channel change. So instead this extension starts that
 * service on a loopback port and registers **one** Pi provider that points at
 * it. Pi sees a normal OpenAI provider; Our Free Model keeps doing the work.
 *
 * Consequences worth knowing:
 *
 *  - `getModels()` is synchronous and Pi calls it during `--list-models`, so the
 *    catalog is mirrored to a JSON cache on disk (the same reason the sibling
 *    `pi-connect-free` does it). A cold process lists the last known roster.
 *  - `auth.apiKey.check()` must NOT start the service: Pi calls it inside one
 *    `Promise.all` for every provider, and a session-less invocation must not
 *    open listeners. It answers from the install's presence instead.
 *  - The service is started lazily from `resolve` (the request path) and from
 *    `session_start`, and stopped on `session_shutdown`.
 *
 * @module pi-connect-ourfreemodel
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  OurFreeModelService,
  isOurFreeModelInstalled,
  readServiceKey,
  resolveDataDir,
  resolveOurFreeModelEntry,
} from "./service.js";
import { registerOurFreeModelCommands } from "./commands.js";

/** The single provider id this extension owns. */
export const PROVIDER_ID = "ourfree";

/** Display name shown in Pi's model picker. */
const DISPLAY_NAME = "Our Free Model";

/**
 * How long a fetched catalog stays fresh before a background re-fetch.
 *
 * Our Free Model rotates channels and quotas on its own schedule; ten minutes
 * is short enough that a newly granted channel shows up in the same session and
 * long enough that a chatty session does not re-list on every turn.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** After a failed fetch, wait this long before trying again on the request path. */
const CATALOG_RETRY_AFTER_FAILURE_MS = 60 * 1000;

/** How long the model-list call may take before the cached roster is used. */
const CATALOG_FETCH_TIMEOUT_MS = 8000;

/** Pi-owned cache root, kept out of Our Free Model's own data dir. */
function cacheDir() {
  return join(homedir(), ".pi", "agent", "cache", "pi-connect-ourfreemodel");
}

function catalogCachePath() {
  return join(cacheDir(), "catalog.json");
}

/**
 * Logger that keeps quiet unless `PI_CONNECT_DEBUG=1`.
 *
 * Pi's TUI owns the terminal: a stray `console.info` during activation prints
 * over the input line and leaves it corrupted. Anything the user must see goes
 * through `ctx.ui.notify` instead.
 */
function createLogger() {
  if (process.env.PI_CONNECT_DEBUG !== "1") {
    return {
      info: () => {},
      warn: () => {},
      error: (message, detail) => console.error(`[pi-connect-ourfreemodel] ${message}`, detail ?? ""),
    };
  }
  return {
    info: (message) => console.info(`[pi-connect-ourfreemodel] ${message}`),
    warn: (message, detail) => console.warn(`[pi-connect-ourfreemodel] ${message}`, detail ?? ""),
    error: (message, detail) => console.error(`[pi-connect-ourfreemodel] ${message}`, detail ?? ""),
  };
}

//#region catalog cache

/**
 * Read the persisted roster.
 *
 * Pi builds its model list synchronously, so there is no chance to await a
 * network call at that moment. A cold start therefore serves whatever the last
 * run discovered; an empty cache means an empty list until the first request or
 * session warm-up fills it.
 */
function loadCachedCatalog(logger) {
  const path = catalogCachePath();
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(document?.models)) return [];
    return document.models.filter(
      (model) => typeof model?.id === "string" && model.id !== "" && typeof model.contextWindow === "number",
    );
  } catch (error) {
    if (existsSync(path)) logger?.warn?.(`could not read the cached catalog at ${path}`, error);
    return [];
  }
}

/** Persist the roster. Best-effort: a failure only costs a cold start. */
function saveCachedCatalog(models, logger) {
  const path = catalogCachePath();
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), models }, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // A leftover temp file is inert.
    }
    logger?.warn?.(`could not save the catalog to ${path}`, error);
  }
}

//#endregion
//#region model mapping

/**
 * An Our Free Model row as a Pi model.
 *
 * `baseUrl` points at the local service. Pi treats a plain `openai-completions`
 * model as an ordinary OpenAI endpoint, which is exactly what the service
 * speaks — no shim of our own is needed, unlike the Qoder/TRAE packages whose
 * upstreams use private protocols.
 */
function toPiModel(row, baseUrl) {
  const contextWindow =
    typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : 128_000;
  const efforts = Array.isArray(row.efforts) ? row.efforts.filter((e) => typeof e === "string") : [];
  return {
    id: row.id,
    name: row.name,
    provider: PROVIDER_ID,
    api: "openai-completions",
    baseUrl,
    // Pi's `--list-models` renders each row through `m.input.includes("image")`
    // and prints `cost` columns; a model without these fields throws inside
    // Pi's own renderer, taking the whole listing down rather than just the
    // row. Both are therefore required, not optional.
    //
    // `input` is text-only because the service's `/v1/models` does not publish
    // a modality field: it keeps vision in a private capability table and only
    // exposes `x_ofm_efforts`. Claiming image support for a model that has not
    // been verified for it would surface as a failed turn at send time, so the
    // honest answer here is text-only until the service publishes the fact.
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // Pi's `--list-models` renders maxTokens through `formatTokenCount`, which
    // throws on `undefined`, so a value must be present. There is no output
    // ceiling this service enforces separately from the window, so declaring
    // the window is display-safe and never truncates.
    maxTokens: contextWindow,
    ...(efforts.length === 0
      ? {}
      : {
          compat: { supportsReasoningEffort: true },
          reasoning: { supported: efforts, defaultEffort: row.defaultEffort ?? efforts[0] },
        }),
  };
}

/**
 * Normalize one `/v1/models` row into the cached shape.
 *
 * The list endpoint answers the OpenAI `model` object with two extras this
 * project adds: `context_window` and `x_ofm_efforts` / `x_ofm_effort_default`.
 * Unknown fields are ignored rather than guessed — a model advertised without a
 * window gets a conservative window, and one advertised without efforts is a
 * non-reasoning model, which is what the service means by omitting them.
 */
function normalizeModelRow(raw) {
  if (typeof raw?.id !== "string" || raw.id === "") return undefined;
  const contextWindow = Number(raw.context_window);
  const efforts = Array.isArray(raw.x_ofm_efforts)
    ? raw.x_ofm_efforts.filter((effort) => typeof effort === "string" && effort !== "")
    : [];
  const defaultEffort = typeof raw.x_ofm_effort_default === "string" ? raw.x_ofm_effort_default : undefined;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(efforts.length === 0 ? {} : { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }),
  };
}

//#endregion

/**
 * The runtime state behind the provider: service handle plus catalog cache.
 */
class Runtime {
  constructor(logger, env) {
    this.logger = logger;
    this.service = new OurFreeModelService({ logger, env });
    this.models = loadCachedCatalog(logger);
    this.discoveredAt = this.models.length > 0 ? Date.now() : 0;
    this.failedAt = 0;
    this.pending = undefined;
  }

  /** The loopback base URL, or a placeholder before the service is up. */
  baseUrlOrPlaceholder() {
    return this.service.baseUrl() ?? "http://127.0.0.1:0/v1";
  }

  /**
   * Re-read the model list from the running service.
   *
   * Single-flight: `resolve` and the warm-up can overlap, and two concurrent
   * fetches would let whichever landed last win. The caller's signal belongs to
   * the flight that created the slot — a joiner is waiting on someone else's
   * fetch and must not cancel it.
   */
  async refreshCatalog(force = false) {
    if (this.pending !== undefined) return this.pending;
    if (!force && this.discoveredAt > 0 && Date.now() - this.discoveredAt < CATALOG_TTL_MS) return undefined;
    if (!force && Date.now() - this.failedAt < CATALOG_RETRY_AFTER_FAILURE_MS) return undefined;
    const flight = this.#fetchCatalog().finally(() => {
      if (this.pending === flight) this.pending = undefined;
    });
    this.pending = flight;
    return flight;
  }

  async #fetchCatalog() {
    const position = await this.service.ensure();
    if (position === undefined) {
      // "Not installed" and "cannot start" are both failures for freshness
      // purposes: retrying on every turn would add a failed start attempt —
      // including its lock-file contention — to each request.
      this.failedAt = Date.now();
      return undefined;
    }
    const deadline = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${position.url}/v1/models`, {
        headers: { authorization: `Bearer ${position.key}` },
        signal: deadline,
      });
    } catch (error) {
      this.failedAt = Date.now();
      this.logger?.warn?.(`ourfreemodel: model list request failed`, error);
      return undefined;
    }
    if (!response.ok) {
      this.failedAt = Date.now();
      this.logger?.warn?.(`ourfreemodel: model list answered HTTP ${response.status}`);
      return undefined;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      this.failedAt = Date.now();
      this.logger?.warn?.(`ourfreemodel: model list is not JSON`, error);
      return undefined;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const models = rows.map(normalizeModelRow).filter((model) => model !== undefined);
    if (models.length === 0) {
      // A 200 that lists nothing is not a usable directory — an account pool
      // with no channel signed in answers exactly this way. Treat it as a
      // failure so the backoff applies instead of hammering the service.
      this.failedAt = Date.now();
      this.logger?.warn?.(`ourfreemodel: model list came back empty; serving the cached roster`);
      return undefined;
    }
    this.models = models;
    this.discoveredAt = Date.now();
    this.failedAt = 0;
    saveCachedCatalog(models, this.logger);
    return models;
  }

  /** Build Pi models from the current roster. */
  toPiModels() {
    const baseUrl = this.baseUrlOrPlaceholder();
    return this.models.map((row) => toPiModel(row, baseUrl));
  }

  async close() {
    await this.service.close();
  }
}

/** Build the Pi provider object. */
function createProvider(runtime, logger) {
  return {
    id: PROVIDER_ID,
    name: DISPLAY_NAME,
    baseUrl: undefined,
    auth: {
      apiKey: {
        name: `${DISPLAY_NAME} local service key`,
        async check() {
          // Never start the service here. Pi calls this for every provider
          // inside one `Promise.all`, and a session-less `pi --list-models`
          // must not open a listener — so the answer comes from the install
          // alone. Throwing is equally wrong: Pi wraps a rejection in
          // `ModelsError`, which takes the whole model list down rather than
          // just this provider.
          try {
            const status = isOurFreeModelInstalled();
            return status.ok ? { type: "api_key", source: DISPLAY_NAME } : undefined;
          } catch (error) {
            logger?.warn?.(`ourfreemodel: availability check failed`, error);
            return undefined;
          }
        },
        async resolve() {
          // The request path. `ensure` is idempotent and single-flight, so two
          // concurrent model calls start one service, not two.
          const position = await runtime.service.ensure();
          if (position === undefined) return undefined;
          // Refresh the roster after the request is accepted, never before: a
          // user's turn must not wait on a model-list round trip. This runs
          // unconditionally on the first request of a cold process — which is
          // precisely when the cache is empty and the list would otherwise stay
          // empty forever. `refreshCatalog` applies the TTL itself, so the
          // steady state is a no-op.
          void runtime.refreshCatalog().catch(() => {});
          return {
            auth: { apiKey: position.key, baseUrl: `${position.url}/v1` },
            source: DISPLAY_NAME,
          };
        },
      },
    },
    getModels: () => runtime.toPiModels(),
    refreshModels: async (context) => {
      // Offline phase: keep whatever Pi already has stored.
      if (context.stored?.models?.length) {
        await context.publish({
          persist: { models: context.stored.models, checkedAt: context.stored.checkedAt },
          update: () => {},
        });
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      // An explicit refresh must skip the TTL, or a roster fetched moments ago
      // would make the user's refresh a no-op.
      await runtime.refreshCatalog(true);
      if (context.signal.aborted) return;
      const models = runtime.toPiModels();
      await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => {} });
    },
    stream: (model, context, options) => stream(model, context, options),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
  };
}

/**
 * Pi extension factory.
 *
 * Registers exactly one provider. Every channel Our Free Model supports appears
 * as a model under that one provider, because that is how the service exposes
 * them — a flat `/v1/models` list routed internally by model id.
 */
export default async function activate(pi) {
  const logger = createLogger();
  const env = process.env;
  const runtime = new Runtime(logger, env);

  const installed = isOurFreeModelInstalled(env);
  if (installed.ok) {
    logger.info(
      `found Our Free Model ${installed.version} at ${installed.root} (data dir ${installed.dataDir}, ${runtime.models.length} cached models)`,
    );
  } else {
    logger.warn(installed.reason);
  }

  try {
    pi.registerProvider(createProvider(runtime, logger));
  } catch (error) {
    logger.error("activation failed; Our Free Model will be unavailable", error);
    return;
  }

  // Warm the service once a session exists — and only then, so a session-less
  // invocation never opens a listener.
  pi.on?.("session_start", async (_event, ctx) => {
    try {
      const position = await runtime.service.ensure();
      if (position === undefined) {
        if (runtime.service.lastFailure !== undefined) {
          ctx?.ui?.notify?.(`Our Free Model 不可用：${runtime.service.lastFailure}`, "warning");
        }
        return;
      }
      await runtime.refreshCatalog(true);
      logger.info(`ready: ${DISPLAY_NAME} (${runtime.models.length} models)`);
    } catch (error) {
      logger.warn("Our Free Model warm-up failed", error);
      ctx?.ui?.notify?.(`Our Free Model 预热失败，模型可能不可用（${error?.message ?? error}）`, "warning");
    }
  });

  // Slash commands: the management page is where channels get signed in, and a
  // session is the only place a listener may open, so this is the right scope.
  registerOurFreeModelCommands(pi, runtime);

  pi.on?.("session_shutdown", () => {
    void runtime.close();
  });

  // Cold-start bootstrap for the one case `session_start` cannot cover:
  // `pi --list-models` (and the startup model picker) reads the roster
  // synchronously and never opens a session, so an empty cache would leave the
  // provider listed with zero models — indistinguishable, to the user, from the
  // extension not being installed at all.
  //
  // It must CLEAN UP, which is the whole subtlety here. The service holds an
  // exclusive lock on its data dir, so a bootstrap that left its listener
  // running would make every later `resolve` in this very process fail with
  // "数据目录已被服务占用" — the provider would list 26 models and then refuse
  // every request. Start, read, stop: the cache is the only thing that needs to
  // outlive this block.
  //
  // Best-effort and non-blocking: Pi is still building its model list while
  // this runs, and a failure is silent because the next session's warm-up
  // retries. Once the first list lands, the cache carries every later cold
  // start, so this fires at most once per machine until the cache is removed.
  if (runtime.models.length === 0) {
    void (async () => {
      try {
        await runtime.refreshCatalog(true);
        if (runtime.models.length > 0) {
          logger.info(`bootstrapped ${runtime.models.length} models for the next cold start`);
        }
      } catch (error) {
        logger.warn("Our Free Model bootstrap failed; the next session will retry", error);
      } finally {
        // Always release the lock, even on failure: a half-started service
        // still holds it.
        await runtime.close();
      }
    })();
  }
}

/** Exported for tests and for the status command. */
export const internals = {
  cacheDir,
  catalogCachePath,
  loadCachedCatalog,
  saveCachedCatalog,
  normalizeModelRow,
  toPiModel,
  CATALOG_TTL_MS,
  CATALOG_RETRY_AFTER_FAILURE_MS,
};
