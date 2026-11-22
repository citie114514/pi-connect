/**
 * Locate and drive the `dsh-our-free-model` standalone service.
 *
 * The whole point of this module is that it reimplements **nothing**. Our Free
 * Model already ships a complete local OpenAI-compatible service
 * (`packages/standalone/service.mjs`) that owns every channel, its login flow,
 * the account pool, credit claiming and the quota bookkeeping. Duplicating any
 * of that here would fork the protocol work, and the fork would drift the first
 * time an upstream channel changed.
 *
 * So this module provides exactly two things:
 *
 *  - {@link resolveOurFreeModelEntry}: find the installed package and turn it
 *    into an importable path, or explain why it cannot.
 *  - {@link OurFreeModelService}: start it on a loopback port, expose the
 *    OpenAI base URL and bearer key Pi needs, and stop it again.
 *
 * Why this is not simply `pi install` of that package: it is a DSH/Cordis
 * plugin (`private: true`, no Pi manifest). What *is* reusable is its
 * standalone entry point, which the upstream project documents as "no DSH,
 * no Cordis, no host credential store".
 *
 * @module pi-connect-ourfreemodel/service
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Select the request transport inside Our Free Model before it starts.
 *
 * Its official OpenCode free lane prefers to proxy through a local **Bun**
 * executable and refuses the lane outright when one is not installed
 * (`src/egress.js`: "OpenCode free inference requires a local Bun executable").
 * The service's own default is `auto`, which means "Bun if present" — correct
 * for a developer machine, wrong for an extension that must work on a plain
 * Node install, where every free model would answer 502 out of the box.
 *
 * So this adapter resolves the question the same way the service would, and:
 *
 *  - honours an explicit `OUR_FREE_MODEL_FREE_TRANSPORT` (`node` / `bun`),
 *    because a user who set it knows what they want;
 *  - keeps `auto` when a Bun executable is genuinely reachable, so nothing is
 *    downgraded on a machine that does have Bun;
 *  - otherwise pins `node`, which is the legacy transport the service keeps
 *    working and the one that needs no extra runtime.
 *
 * The value is written onto `env`, which is the process environment the service
 * reads, so it must be set before `startStandalone`.
 */
function applyTransportDefault(env) {
  const explicit = String(env.OUR_FREE_MODEL_FREE_TRANSPORT ?? "").trim();
  if (explicit !== "") return explicit;
  // `OUR_FREE_MODEL_BUN` is the service's own escape hatch for a Bun that is not
  // on PATH; if it is set, Bun is reachable and `auto` stays correct.
  const bunHint = String(env.OUR_FREE_MODEL_BUN ?? "").trim();
  if (bunHint !== "") {
    try {
      if (statSync(bunHint).isFile()) return "auto";
    } catch {
      // A stale hint is ignored; fall through to the node default.
    }
  }
  // Bun on PATH.
  const pathValue = String(env.PATH ?? env.Path ?? "");
  const names = process.platform === "win32" ? ["bun.exe", "bun.cmd"] : ["bun"];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const name of names) {
      try {
        if (statSync(join(dir, name)).isFile()) return "auto";
      } catch {
        // Not in this directory.
      }
    }
  }
  env.OUR_FREE_MODEL_FREE_TRANSPORT = "node";
  return "node";
}

/**
 * Where an installed Our Free Model might live, most specific first.
 *
 * A caller-set `PI_OURFREEMODEL_PATH` wins outright: the package is normally a
 * sibling of this checkout during development and a subdirectory of the DSH
 * profile once installed, and neither is something a published extension can
 * guess reliably on every machine.
 */
export function candidateRoots(env = process.env, home = homedir()) {
  const roots = [];
  const override = String(env.PI_OURFREEMODEL_PATH ?? "").trim();
  if (override !== "") roots.push(resolvePath(override));
  const dshHome = String(env.DSH_HOME ?? "").trim() || join(home, ".dsh");
  // The installed form: a DSH profile's node_modules.
  roots.push(join(dshHome, "profiles", "desktop", "node_modules", "dsh-our-free-model"));
  // The checkout form: siblings of this extension inside the plugin repo.
  roots.push(join(home, ".dsh", "pi-extensions", "dsh-our-free-model"));
  return roots;
}

/**
 * Resolve the standalone service entry point.
 *
 * Returns `{ entry, root, version }` on success, or `{ reason }` describing the
 * first thing that was wrong. The reason is deliberately specific — "OFM is not
 * installed" and "OFM is installed but predates the standalone entry point"
 * call for completely different user action.
 *
 * @returns {{ entry: string, root: string, version: string } | { reason: string }}
 */
export function resolveOurFreeModelEntry(env = process.env, home = homedir()) {
  const tried = [];
  for (const root of candidateRoots(env, home)) {
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) {
      tried.push(`${root} (no package.json)`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (error) {
      tried.push(`${root} (package.json is not valid JSON: ${error.message})`);
      continue;
    }
    // `main` is the DSH/Cordis entry. The standalone one is separate on
    // purpose and is what carries no host dependency; a package old enough to
    // lack it cannot be driven from Pi at all.
    const entry = join(root, "packages", "standalone", "service.mjs");
    if (!existsSync(entry)) {
      tried.push(`${root} (v${pkg.version ?? "?"} has no packages/standalone/service.mjs)`);
      continue;
    }
    return { entry, root, version: String(pkg.version ?? "unknown") };
  }
  return {
    reason:
      tried.length === 0
        ? "dsh-our-free-model was not found; set PI_OURFREEMODEL_PATH to its directory"
        : `dsh-our-free-model was not found in any known location (${tried.join("; ")}); set PI_OURFREEMODEL_PATH to its directory`,
  };
}

/**
 * Where Our Free Model keeps its own data (credentials, account pool, key).
 *
 * This defaults to **Our Free Model's own home**, so a user who also runs
 * `npm run start:standalone` shares one account pool instead of silently
 * getting a second, empty one — and so the channels they signed in through the
 * management page are the channels Pi uses.
 *
 * The catch is the service's lock: one data dir admits exactly one running
 * instance, and the lock file records only a pid, not a port, so a second
 * process cannot attach to the first. Pi therefore has to outlive the
 * contention by failing politely rather than by starting a rival. Callers who
 * want Pi to keep its own instance (for example to run alongside a standalone
 * one) point `PI_OURFREEMODEL_DATA_DIR` at a separate directory, and that is
 * documented as the supported way rather than papered over here.
 */
export function resolveDataDir(env = process.env, home = homedir()) {
  const override = String(env.PI_OURFREEMODEL_DATA_DIR ?? "").trim();
  if (override !== "") return resolvePath(override);
  const ofmHome = String(env.OFM_HOME ?? "").trim();
  if (ofmHome !== "") return resolvePath(ofmHome);
  return join(home, ".our-free-model");
}

/**
 * Whether the failure was "another instance owns this data dir".
 *
 * This is a *user-recoverable* condition with its own remedy, so it must not be
 * reported as "Our Free Model is broken". The service signals it with
 * `code: "EEXIST"` and a Chinese message; both are checked because the code is
 * the contract and the message is what reaches a log.
 */
function isLockContention(error) {
  if (error?.code === "EEXIST") return true;
  return typeof error?.message === "string" && error.message.includes("数据目录已被服务占用");
}

/** Read the bearer key out of the service's own settings file. */
export function readServiceKey(dataDir) {
  const path = join(dataDir, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const key = settings?.forwardKey;
    return typeof key === "string" && key !== "" ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A started Our Free Model service plus the bits Pi needs from it.
 *
 * Start is idempotent and single-flight: Pi may call `resolve` concurrently for
 * two models, and starting the service twice would race its lock file.
 */
export class OurFreeModelService {
  constructor({ logger, env = process.env, home = homedir() } = {}) {
    this.logger = logger;
    this.env = env;
    this.home = home;
    this.started = undefined;
    this.disposed = false;
    this.position = undefined;
  }

  /** The service's OpenAI-compatible base URL, once started. */
  baseUrl() {
    if (this.position === undefined) return undefined;
    return `${this.position.url}/v1`;
  }

  /** The bearer key Pi attaches to each request, once started. */
  apiKey() {
    return this.position?.key;
  }

  /**
   * Start the service (once) and return `{ url, key, dataDir }`.
   *
   * Returns `undefined` — never throws — when Our Free Model cannot be used, so
   * the provider can answer "not available" instead of breaking Pi's model
   * list. The reason is logged for `/ourfreemodel-status`.
   */
  async ensure() {
    if (this.position !== undefined) return this.position;
    if (this.started !== undefined) return this.started;
    this.started = this.#start().finally(() => {
      // Only the flight that still owns the slot may release it.
      if (this.started !== undefined && this.position === undefined) this.started = undefined;
    });
    return this.started;
  }

  async #start() {
    const resolved = resolveOurFreeModelEntry(this.env, this.home);
    if ("reason" in resolved) {
      this.lastFailure = resolved.reason;
      this.logger?.warn?.(`ourfreemodel: ${resolved.reason}`);
      return undefined;
    }
    const dataDir = resolveDataDir(this.env, this.home);
    const transport = applyTransportDefault(this.env);
    this.logger?.info?.(`ourfreemodel: free-lane transport ${transport}`);
    let module;
    try {
      module = await import(pathToFileURL(resolved.entry).href);
    } catch (error) {
      this.lastFailure = `could not import ${resolved.entry}: ${error.message}`;
      this.logger?.warn?.(`ourfreemodel: ${this.lastFailure}`);
      return undefined;
    }
    if (typeof module.startStandalone !== "function") {
      this.lastFailure = `${resolved.entry} does not export startStandalone`;
      this.logger?.warn?.(`ourfreemodel: ${this.lastFailure}`);
      return undefined;
    }
    let service;
    try {
      service = await module.startStandalone({
        dataDir,
        host: "127.0.0.1",
        // Port 0: the OS picks one. A fixed port would collide with the user's
        // own `start:standalone`, and the lock file only covers the data dir.
        port: 0,
        // Keep the console quiet unless the operator asked for chatter: Pi's
        // TUI owns the terminal, and a stray write during activation corrupts
        // the input line.
        logger: {
          info: () => {},
          warn: (message) => this.logger?.warn?.(`ourfreemodel: ${message}`),
          error: (message) => this.logger?.warn?.(`ourfreemodel: ${message}`),
          log: () => {},
          debug: () => {},
        },
      });
    } catch (error) {
      // Two different problems, two different remedies. A locked data dir means
      // another instance already owns the account pool — the user can close it,
      // or point Pi at its own directory with PI_OURFREEMODEL_DATA_DIR. Anything
      // else is a genuine start failure. Reporting both as "could not start"
      // would leave the user guessing at the one case they can actually fix.
      if (isLockContention(error)) {
        this.lastFailure =
          `另一个 Our Free Model 实例正在使用数据目录 ${dataDir}（独立服务与 Pi 不能同时占用同一个目录）。` +
          `关掉那个实例，或设置 PI_OURFREEMODEL_DATA_DIR 指向另一个目录。`;
      } else {
        this.lastFailure = `could not start the service: ${error.message}`;
      }
      this.logger?.warn?.(`ourfreemodel: ${this.lastFailure}`);
      return undefined;
    }
    this.handle = service;
    // The key is written to settings.json during start, so reading it now is
    // reading the value the running listener actually enforces.
    const key = readServiceKey(dataDir);
    if (key === undefined) {
      await this.close();
      this.lastFailure = `the service started but ${join(dataDir, "settings.json")} carries no forwardKey`;
      this.logger?.warn?.(`ourfreemodel: ${this.lastFailure}`);
      return undefined;
    }
    this.position = { url: service.url, key, dataDir, version: resolved.version, root: resolved.root };
    this.lastFailure = undefined;
    this.logger?.info?.(
      `ourfreemodel: service ${resolved.version} listening on ${service.url} (${service.channels ? "channels ready" : "channels pending"})`,
    );
    return this.position;
  }

  /** Stop the service. Safe to call when it never started. */
  async close() {
    this.disposed = true;
    this.position = undefined;
    const handle = this.handle;
    this.handle = undefined;
    if (handle === undefined) return;
    try {
      await handle.close();
    } catch (error) {
      this.logger?.warn?.(`ourfreemodel: could not stop the service cleanly: ${error.message}`);
    }
  }
}

/**
 * Whether an Our Free Model install looks usable, without starting anything.
 *
 * This is what `auth.apiKey.check` answers from: starting a listener inside a
 * session-less `pi --list-models` would be both surprising and slow, so the
 * check reports availability from the package's presence alone.
 */
export function isOurFreeModelInstalled(env = process.env, home = homedir()) {
  const resolved = resolveOurFreeModelEntry(env, home);
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  // A data dir that does not exist yet is fine — the service creates it — but
  // one that exists and is not a directory never will be.
  const dataDir = resolveDataDir(env, home);
  if (existsSync(dataDir)) {
    try {
      if (!statSync(dataDir).isDirectory()) {
        return { ok: false, reason: `${dataDir} exists but is not a directory` };
      }
    } catch (error) {
      return { ok: false, reason: `${dataDir} is unreadable: ${error.message}` };
    }
  }
  return { ok: true, root: resolved.root, version: resolved.version, dataDir };
}

/**
 * Seams for the offline test suite.
 *
 * `applyTransportDefault` mutates an env object, and testing it against the real
 * `process.env` would leak a transport choice into the rest of the run.
 */
export const __internals = { applyTransportDefault, candidateRoots };
