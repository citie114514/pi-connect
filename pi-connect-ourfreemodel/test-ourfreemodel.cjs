/**
 * Offline tests for pi-connect-ourfreemodel.
 *
 * No network, no service start, no real Our Free Model install required: every
 * decision this adapter makes is exercised against injected inputs. The parts
 * that genuinely need the upstream package (starting the listener, its channel
 * runtimes) are covered by the live probe documented in the README, because a
 * test that started the real service would depend on an installed copy and on
 * whichever free pools happen to be in quota.
 *
 * Run: node test-ourfreemodel.cjs
 */
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(
      () => { passed += 1; },
      (error) => { failures.push(`${name} — ${error.message}`); },
    );
    passed += 1;
  } catch (error) {
    failures.push(`${name} — ${error.message}`);
  }
  return Promise.resolve();
}

const root = mkdtempSync(join(tmpdir(), "ofm-test-"));

/** Build a fake Our Free Model install with or without the standalone entry. */
function fakeInstall({ version = "2.7.2", withStandalone = true } = {}) {
  const dir = join(root, `ofm-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-our-free-model", version }), "utf8");
  if (withStandalone) {
    mkdirSync(join(dir, "packages", "standalone"), { recursive: true });
    writeFileSync(join(dir, "packages", "standalone", "service.mjs"), "export async function startStandalone() {}\n", "utf8");
  }
  return dir;
}

(async () => {
  const service = await import(pathToFileURL(join(__dirname, "service.js")).href);
  const index = await import(pathToFileURL(join(__dirname, "index.js")).href);

  // --- 1. Resolution: an explicit override wins over every guess ---
  await test("PI_OURFREEMODEL_PATH is honoured", () => {
    const dir = fakeInstall();
    const resolved = service.resolveOurFreeModelEntry({ PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") }, root);
    assert.ok(!("reason" in resolved), `expected success, got ${resolved.reason}`);
    assert.equal(resolved.version, "2.7.2");
    assert.ok(resolved.entry.endsWith(join("packages", "standalone", "service.mjs")));
  });

  // --- 2. The DSH profile layout is still discoverable as a *fallback* ---
  await test("the DSH profile node_modules layout is a known fallback root", () => {
    const dshHome = join(root, `dsh-${Math.random().toString(36).slice(2)}`);
    const dir = join(dshHome, "profiles", "desktop", "node_modules", "dsh-our-free-model");
    mkdirSync(join(dir, "packages", "standalone"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.7.2" }), "utf8");
    writeFileSync(join(dir, "packages", "standalone", "service.mjs"), "export {}\n", "utf8");
    // `candidateRoots` is the external-install search list; the bundled copy is
    // consulted separately and deliberately outranks it.
    const roots = service.candidateRoots({ DSH_HOME: dshHome }, root);
    assert.ok(roots.includes(dir), `expected ${dir} among ${roots.join(", ")}`);
    // And it does resolve when the bundle cannot be used (simulated by an
    // override that points nowhere): the fallback exists for real.
    const resolved = service.resolveOurFreeModelEntry(
      { PI_OURFREEMODEL_PATH: join(root, "absent-override"), DSH_HOME: dshHome },
      root,
    );
    assert.ok(!("reason" in resolved), `expected the DSH install to be found, got ${resolved.reason}`);
    assert.equal(resolved.root, dir);
    assert.equal(resolved.source, "external");
  });

  // --- 3. The bundled copy is what makes this package work with nothing installed ---
  await test("the vendored copy resolves with no external install and no DSH", () => {
    const resolved = service.resolveOurFreeModelEntry(
      { DSH_HOME: join(root, "no-dsh-anywhere") },
      join(root, "empty-home"),
    );
    assert.ok(!("reason" in resolved), `expected the bundled copy to resolve, got: ${resolved.reason}`);
    assert.equal(resolved.source, "vendored");
    assert.ok(resolved.entry.endsWith(join("packages", "standalone", "service.mjs")));
    assert.ok(resolved.root.includes("vendor"), `expected a bundled root, got ${resolved.root}`);
  });
  await test("an explicit override outranks the bundled copy", () => {
    const dir = fakeInstall();
    const resolved = service.resolveOurFreeModelEntry(
      { PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") },
      join(root, "empty-home"),
    );
    assert.ok(!("reason" in resolved));
    assert.equal(resolved.source, "external");
    assert.equal(resolved.root, dir);
  });
  await test("an override pointing at a broken install reports that specifically", () => {
    const dir = fakeInstall({ withStandalone: false, version: "1.0.0" });
    const resolved = service.resolveOurFreeModelEntry(
      { PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") },
      join(root, "empty-home"),
    );
    // A bad override must not silently fall back to the bundle: that would make
    // a pinning mistake look like it worked.
    assert.ok("reason" in resolved, "expected a failure reason");
    assert.match(resolved.reason, /PI_OURFREEMODEL_PATH/);
    assert.match(resolved.reason, /service\.mjs/);
  });

  // --- 5. Data dir: Pi never invents a second account pool ---
  await test("PI_OURFREEMODEL_DATA_DIR wins over OFM_HOME", () => {
    const explicit = join(root, "explicit");
    assert.equal(service.resolveDataDir({ PI_OURFREEMODEL_DATA_DIR: explicit, OFM_HOME: join(root, "ofm") }, root), explicit);
  });
  await test("OFM_HOME is honoured when the Pi-specific override is unset", () => {
    const ofmHome = join(root, "ofm-home");
    assert.equal(service.resolveDataDir({ OFM_HOME: ofmHome }, root), ofmHome);
  });
  await test("the default data dir is Pi-specific, not Our Free Model's own home", () => {
    // Sharing `~/.our-free-model` would collide with a separately launched
    // standalone service on the same lock, so the default must be its own path.
    const dir = service.resolveDataDir({}, root);
    assert.ok(dir.startsWith(join(root, ".pi", "agent", "cache")), `expected a Pi cache path, got ${dir}`);
    assert.notEqual(dir, join(root, ".our-free-model"));
  });

  // --- 6. The key is read from the service's own settings file ---
  await test("readServiceKey reads forwardKey", () => {
    const dir = join(root, "key-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ forwardKey: "abc123" }), "utf8");
    assert.equal(service.readServiceKey(dir), "abc123");
  });
  await test("readServiceKey returns undefined rather than throwing on junk", () => {
    const dir = join(root, "key-junk");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json", "utf8");
    assert.equal(service.readServiceKey(dir), undefined);
    assert.equal(service.readServiceKey(join(root, "key-absent")), undefined);
    const emptyKeyDir = join(root, "key-empty");
    mkdirSync(emptyKeyDir, { recursive: true });
    writeFileSync(join(emptyKeyDir, "settings.json"), JSON.stringify({ forwardKey: "" }), "utf8");
    assert.equal(service.readServiceKey(emptyKeyDir), undefined);
  });

  // --- 7. Installed-ness is answered without starting anything ---
  await test("isOurFreeModelInstalled is ok from the bundled copy alone", () => {
    const status = service.isOurFreeModelInstalled(
      { DSH_HOME: join(root, "no-dsh-anywhere") },
      join(root, "empty-home"),
    );
    assert.equal(status.ok, true, `expected ok, got ${status.reason}`);
    assert.ok(status.root.includes("vendor"));
  });
  await test("isOurFreeModelInstalled reports a reason when even the bundle is unusable", () => {
    // Point the override at a broken install and the bundle at nothing, which is
    // the only remaining way for this to fail.
    const dir = fakeInstall({ withStandalone: false });
    const status = service.isOurFreeModelInstalled(
      { PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") },
      join(root, "empty-home"),
    );
    assert.equal(status.ok, false);
    assert.match(status.reason, /PI_OURFREEMODEL_PATH/);
  });
  await test("isOurFreeModelInstalled rejects a dataDir that is a file", () => {
    const dataDir = join(root, "not-a-dir-2");
    writeFileSync(dataDir, "x", "utf8");
    const status = service.isOurFreeModelInstalled(
      { DSH_HOME: join(root, "no-dsh-anywhere"), PI_OURFREEMODEL_DATA_DIR: dataDir },
      join(root, "empty-home"),
    );
    assert.equal(status.ok, false);
    assert.match(status.reason, /not a directory/);
  });

  // --- 8. The transport default never silently breaks the free lane ---
  await test("transport falls back to node when Bun is unreachable", () => {
    const env = { PATH: join(root, "empty-path") };
    mkdirSync(env.PATH, { recursive: true });
    const { applyTransportDefault } = service.__internals;
    assert.equal(applyTransportDefault(env), "node");
    assert.equal(env.OUR_FREE_MODEL_FREE_TRANSPORT, "node");
  });
  await test("an explicit transport is never overridden", () => {
    const { applyTransportDefault } = service.__internals;
    for (const value of ["node", "bun", "auto"]) {
      const env = { OUR_FREE_MODEL_FREE_TRANSPORT: value, PATH: join(root, "empty-path") };
      assert.equal(applyTransportDefault(env), value);
      assert.equal(env.OUR_FREE_MODEL_FREE_TRANSPORT, value);
    }
  });
  await test("transport stays auto when a Bun executable is reachable", () => {
    const { applyTransportDefault } = service.__internals;
    const binDir = join(root, "bun-bin");
    mkdirSync(binDir, { recursive: true });
    const name = process.platform === "win32" ? "bun.exe" : "bun";
    writeFileSync(join(binDir, name), "", "utf8");
    const env = { PATH: binDir };
    assert.equal(applyTransportDefault(env), "auto");
    // Nothing is written when auto is already the answer.
    assert.equal(env.OUR_FREE_MODEL_FREE_TRANSPORT, undefined);
  });
  await test("a reachable OUR_FREE_MODEL_BUN hint keeps auto", () => {
    const { applyTransportDefault } = service.__internals;
    const bun = join(root, "custom-bun");
    writeFileSync(bun, "", "utf8");
    const env = { OUR_FREE_MODEL_BUN: bun, PATH: join(root, "empty-path") };
    assert.equal(applyTransportDefault(env), "auto");
  });
  await test("a stale OUR_FREE_MODEL_BUN hint falls back to node", () => {
    const { applyTransportDefault } = service.__internals;
    const env = { OUR_FREE_MODEL_BUN: join(root, "gone"), PATH: join(root, "empty-path") };
    assert.equal(applyTransportDefault(env), "node");
  });

  // --- 9. Model row normalization ---
  await test("normalizeModelRow maps the service's own extras", () => {
    const row = index.internals.normalizeModelRow({
      id: "mimo-v2.6-flash-free",
      object: "model",
      owned_by: "our-free-model",
      context_window: 1048576,
      x_ofm_efforts: ["light", "balanced", "deep"],
      x_ofm_effort_default: "balanced",
    });
    assert.deepEqual(row, {
      id: "mimo-v2.6-flash-free",
      name: "mimo-v2.6-flash-free",
      contextWindow: 1048576,
      efforts: ["light", "balanced", "deep"],
      defaultEffort: "balanced",
    });
  });
  await test("normalizeModelRow drops rows with no usable id", () => {
    assert.equal(index.internals.normalizeModelRow({}), undefined);
    assert.equal(index.internals.normalizeModelRow({ id: "" }), undefined);
    assert.equal(index.internals.normalizeModelRow(null), undefined);
  });
  await test("normalizeModelRow omits a window it cannot trust", () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, "abc"]) {
      const row = index.internals.normalizeModelRow({ id: "x", context_window: bad });
      assert.equal(row.contextWindow, undefined, `context_window=${String(bad)} should be dropped`);
    }
  });
  await test("normalizeModelRow treats a model without efforts as non-reasoning", () => {
    const row = index.internals.normalizeModelRow({ id: "plain", context_window: 1000 });
    assert.equal("efforts" in row, false);
    assert.equal("defaultEffort" in row, false);
  });

  // --- 10. Pi model mapping ---
  await test("toPiModel declares a window Pi can render", () => {
    const model = index.internals.toPiModel({ id: "x", name: "X", contextWindow: 200000 }, "http://127.0.0.1:1/v1");
    assert.equal(model.provider, "ourfree");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "http://127.0.0.1:1/v1");
    assert.equal(model.contextWindow, 200000);
    // Pi's --list-models throws on an undefined maxTokens, so it must be set.
    assert.equal(model.maxTokens, 200000);
    assert.equal("compat" in model, false, "a non-reasoning model must not claim effort support");
  });
  await test("toPiModel carries the fields Pi's renderer requires", () => {
    // Pi's --list-models does `m.input.includes("image")` and formats `cost`,
    // so an absent `input` crashes the whole listing, not just this row.
    const model = index.internals.toPiModel({ id: "x", name: "X", contextWindow: 1000 }, "http://127.0.0.1:1/v1");
    assert.ok(Array.isArray(model.input), "input must be an array");
    assert.deepEqual(model.input, ["text"], "the service publishes no modality field, so text-only");
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  await test("toPiModel falls back to a conservative window", () => {
    const model = index.internals.toPiModel({ id: "x", name: "X" }, "http://127.0.0.1:1/v1");
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 128000);
  });
  await test("toPiModel advertises reasoning only when efforts exist", () => {
    const model = index.internals.toPiModel(
      { id: "x", name: "X", contextWindow: 1000, efforts: ["low", "high"], defaultEffort: "high" },
      "http://127.0.0.1:1/v1",
    );
    assert.deepEqual(model.compat, { supportsReasoningEffort: true });
    assert.deepEqual(model.reasoning, { supported: ["low", "high"], defaultEffort: "high" });
  });

  // --- 11. The catalog cache round-trips and rejects junk ---
  await test("the catalog cache round-trips", async () => {
    const models = [{ id: "a", name: "A", contextWindow: 1000 }];
    index.internals.saveCachedCatalog(models, { warn: () => {} });
    const loaded = index.internals.loadCachedCatalog({ warn: () => {} });
    assert.deepEqual(loaded, models);
  });
  await test("a missing catalog cache is an empty list, not a throw", () => {
    const path = index.internals.catalogCachePath();
    if (existsSync(path)) rmSync(path);
    assert.deepEqual(index.internals.loadCachedCatalog({ warn: () => {} }), []);
  });

  // --- 12. Constants that other code depends on stay sane ---
  await test("the catalog TTL and backoff are both positive", () => {
    assert.ok(index.internals.CATALOG_TTL_MS > 0);
    assert.ok(index.internals.CATALOG_RETRY_AFTER_FAILURE_MS > 0);
    // A backoff longer than the TTL would make an explicit refresh the only way
    // to ever see a new model.
    assert.ok(index.internals.CATALOG_RETRY_AFTER_FAILURE_MS < index.internals.CATALOG_TTL_MS);
  });

  await test("the readiness wait is bounded and shorter than the catalog TTL", () => {
    // Measured: account channels attach ~2–4 s after the listener comes up. The
    // bound has to be comfortably above that, or the roster keeps excluding
    // them; and far below the TTL, or a hung channel runtime would stall the
    // first fetch past the point where the cache could ever be written.
    assert.ok(index.internals.CATALOG_READY_TIMEOUT_MS >= 10_000);
    assert.ok(index.internals.CATALOG_READY_TIMEOUT_MS < index.internals.CATALOG_TTL_MS);
  });

  // --- 13. The login surface ---
  await test("activation registers exactly the login and status commands", async () => {
    const commands = [];
    const providers = [];
    await index.default({
      registerProvider: (p) => providers.push(p),
      on: () => {},
      registerCommand: (name) => commands.push(name),
    });
    assert.deepEqual(providers.map((p) => p.id), ["ourfree"]);
    assert.deepEqual(commands.sort(), ["ourfreemodel-login", "ourfreemodel-status"]);
  });

  await test("the login command surfaces a management link with a bootstrap token", async () => {
    // The service is the only thing that can mint this link, so a fake one
    // stands in: what is under test is that the command hands the URL to the
    // user rather than swallowing it.
    const commands = await import(pathToFileURL(join(__dirname, "commands.js")).href);
    let registered;
    const fakeRuntime = {
      models: [],
      service: {
        lastFailure: undefined,
        async ensure() {
          return {
            url: "http://127.0.0.1:1",
            key: "k",
            dataDir: "/tmp/x",
            version: "test",
            root: "/vendored/ofm",
            managementUrl: "http://127.0.0.1:1/#login=abc123",
          };
        },
        get position() {
          return undefined;
        },
        get handle() {
          return undefined;
        },
      },
    };
    const byName = new Map();
    commands.registerOurFreeModelCommands(
      { registerCommand: (name, def) => byName.set(name, def) },
      fakeRuntime,
    );
    registered = { name: "ourfreemodel-login", def: byName.get("ourfreemodel-login") };
    assert.ok(registered.def !== undefined, "login command was not registered");

    const notices = [];
    const printed = [];
    const originalLog = console.log;
    console.log = (...args) => printed.push(args.join(" "));
    try {
      await registered.def.handler([], { ui: { notify: (text) => notices.push(text) } });
    } finally {
      console.log = originalLog;
    }
    const all = [...notices, ...printed].join("\n");
    assert.match(all, /#login=abc123/, `expected the link to reach the user, got: ${all}`);
    assert.match(all, /一次性/, "expected the one-time-use warning");
  });

  await test("the status command never invents a signed-in state", async () => {
    const commands = await import(pathToFileURL(join(__dirname, "commands.js")).href);
    let registered;
    const fakeRuntime = {
      models: [{ id: "m" }],
      service: {
        lastFailure: undefined,
        position: { dataDir: "/tmp/x", version: "test", root: "/vendored/ofm" },
        async ensure() {
          return this.position;
        },
        get handle() {
          // The real surface: `state()` reports the runtime's health and
          // `providers` is a bare id list; sign-in lives behind
          // `channels.rpc("provider.status", …)`.
          return {
            channels: {
              state: () => ({ state: "ready", error: "" }),
              providers: ["lobsterai", "qoder"],
              rpc: async (request) => {
                assert.equal(request.method, "provider.status");
                assert.deepEqual(request.payload.providers, ["lobsterai", "qoder"]);
                return {
                  ok: true,
                  value: {
                    statuses: {
                      lobsterai: { accounts: { total: 2, enabled: 1 } },
                      qoder: { accounts: { total: 0, enabled: 0 } },
                    },
                  },
                };
              },
            },
          };
        },
      },
    };
    const byName = new Map();
    commands.registerOurFreeModelCommands(
      { registerCommand: (name, def) => byName.set(name, def) },
      fakeRuntime,
    );
    const def = byName.get("ourfreemodel-status");
    assert.ok(def !== undefined, "status command was not registered");
    registered = { name: "ourfreemodel-status", def };
    const notices = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      await registered.def.handler([], { ui: { notify: (text) => notices.push(text) } });
    } finally {
      console.log = originalLog;
    }
    const text = notices.join("\n");
    assert.match(text, /渠道运行时：ready/, `expected the runtime state, got: ${text}`);
    // Account counts come from the same call the management page makes.
    assert.match(text, /已登录：lobsterai（1\/2 账号启用）/, `expected the signed-in channel, got: ${text}`);
    assert.match(text, /未登录：qoder/, `expected the signed-out channel, got: ${text}`);
  });

  await test("status degrades to 'unknown' when provider.status fails", async () => {
    // "Could not ask" must never render as "0 accounts signed in": those call
    // for different user action, and a false zero would send someone through a
    // login they do not need.
    const commands = await import(pathToFileURL(join(__dirname, "commands.js")).href);
    const fakeRuntime = {
      models: [],
      service: {
        lastFailure: undefined,
        position: { dataDir: "/tmp/x", version: "test", root: "/vendored/ofm" },
        get handle() {
          return {
            channels: {
              state: () => ({ state: "ready", error: "" }),
              providers: ["lobsterai"],
              rpc: async () => {
                throw new Error("simulated rpc failure");
              },
            },
          };
        },
      },
    };
    const byName = new Map();
    commands.registerOurFreeModelCommands(
      { registerCommand: (name, def) => byName.set(name, def) },
      fakeRuntime,
    );
    const notices = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      await byName.get("ourfreemodel-status").handler([], { ui: { notify: (t) => notices.push(t) } });
    } finally {
      console.log = originalLog;
    }
    const text = notices.join("\n");
    assert.match(text, /无法读取/, `expected an explicit unknown, got: ${text}`);
    assert.doesNotMatch(text, /未登录：/, "a failed status call must not be reported as signed out");
  });

  rmSync(root, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log(`PASS  pi-connect-ourfreemodel 全部通过（${passed} 项断言）`);
})();
