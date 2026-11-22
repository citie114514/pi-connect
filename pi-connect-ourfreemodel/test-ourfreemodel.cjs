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

  // --- 2. Resolution: the DSH profile layout is discovered without an override ---
  await test("the DSH profile node_modules layout is found", () => {
    const dshHome = join(root, `dsh-${Math.random().toString(36).slice(2)}`);
    const dir = join(dshHome, "profiles", "desktop", "node_modules", "dsh-our-free-model");
    mkdirSync(join(dir, "packages", "standalone"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.7.2" }), "utf8");
    writeFileSync(join(dir, "packages", "standalone", "service.mjs"), "export {}\n", "utf8");
    const resolved = service.resolveOurFreeModelEntry({ DSH_HOME: dshHome }, root);
    assert.ok(!("reason" in resolved), `expected success, got ${resolved.reason}`);
    assert.equal(resolved.root, dir);
  });

  // --- 3. Resolution: a package too old to carry the standalone entry is named as such ---
  await test("a package without the standalone entry reports why", () => {
    const dir = fakeInstall({ withStandalone: false, version: "1.0.0" });
    const resolved = service.resolveOurFreeModelEntry({ PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") }, root);
    assert.ok("reason" in resolved, "expected a failure reason");
    assert.match(resolved.reason, /no packages\/standalone\/service\.mjs/);
    assert.match(resolved.reason, /1\.0\.0/);
  });

  // --- 4. Resolution: absent everywhere names the override ---
  await test("a missing install names the override variable", () => {
    const resolved = service.resolveOurFreeModelEntry({ DSH_HOME: join(root, "absent") }, join(root, "absent-home"));
    assert.ok("reason" in resolved);
    assert.match(resolved.reason, /PI_OURFREEMODEL_PATH/);
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
  await test("the default is Our Free Model's own home, not a Pi cache path", () => {
    const dir = service.resolveDataDir({}, root);
    assert.equal(dir, join(root, ".our-free-model"));
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
  await test("isOurFreeModelInstalled reports ok for a valid install", () => {
    const dir = fakeInstall();
    const status = service.isOurFreeModelInstalled({ PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope") }, root);
    assert.equal(status.ok, true);
    assert.equal(status.version, "2.7.2");
  });
  await test("isOurFreeModelInstalled reports a reason when absent", () => {
    const status = service.isOurFreeModelInstalled({ DSH_HOME: join(root, "nope") }, join(root, "absent-home"));
    assert.equal(status.ok, false);
    assert.match(status.reason, /PI_OURFREEMODEL_PATH/);
  });
  await test("isOurFreeModelInstalled rejects a dataDir that is a file", () => {
    const dir = fakeInstall();
    const dataDir = join(root, "not-a-dir");
    writeFileSync(dataDir, "x", "utf8");
    const status = service.isOurFreeModelInstalled(
      { PI_OURFREEMODEL_PATH: dir, DSH_HOME: join(root, "nope"), PI_OURFREEMODEL_DATA_DIR: dataDir },
      root,
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

  rmSync(root, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log(`PASS  pi-connect-ourfreemodel 全部通过（${passed} 项断言）`);
})();
