/**
 * Regression tests for the two credential-selection faults that made Trae
 * disappear from Pi's model list.
 *
 *  1. `readAll()` returned the desktop copy of an account in preference to the
 *     plugin-owned copy, even when the plugin's own copy was the live one. The
 *     SOLO refresh contract rotates the refresh token, so the copy still in
 *     Trae's `storage.json` is dead after the first plugin refresh; re-using it
 *     answered 401/20101 and every request threw.
 *  2. `auth.apiKey.check()` used `store.resolve()`, which starts a token
 *     refresh. A failing refresh was swallowed into `undefined`, and Pi reads a
 *     falsy check as "signed out" and removes the provider entirely — so a
 *     transient failure looked like the account had vanished.
 *
 * The suite is offline: no network, no real credential files. It builds stores
 * over an injected storage path and an injected plugin-owned copy.
 *
 * Run: node test-credentials.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraeCredentialStore, regionOfCredential } from "./lib/trae-core.js";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const root = mkdtempSync(join(tmpdir(), "trae-cred-test-"));
const now = Date.now();
const HOUR = 60 * 60 * 1000;

/**
 * Build a Trae `storage.json` document carrying one signed-in SOLO account.
 * Mirrors the real shape closely enough for `parseTraeStorageDocument`:
 * the credential lives under `iCubeAuthInfo://icube.cloudide`.
 */
function storageDocument({ accessExpiresAtMs, refreshToken, refreshExpiresAtMs, userId = "1001" }) {
  return JSON.stringify({
    "telemetry.machineId": "machine-a",
    "telemetry.devDeviceId": "device-a",
    "iCubeLastVersion": "1.0.0",
    "iCubeAuthInfo://icube.cloudide": JSON.stringify({
      token: "desktop-access-token",
      refreshToken,
      userId,
      host: "https://api.trae.cn",
      userRegion: { region: "CN" },
      expiredAt: accessExpiresAtMs,
    }),
  });
}

/** Build a plugin-owned copy in the shape `parseOwn` expects. */
function ownDocument({ accessExpiresAtMs, refreshToken, refreshExpiresAtMs, userId = "1001" }) {
  return JSON.stringify({
    version: 1,
    credential: {
      edition: "solo",
      accessToken: "own-access-token",
      refreshToken,
      userId,
      host: "https://api.trae.cn",
      userRegion: "CN",
      expiresAtMs: accessExpiresAtMs,
      ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    },
  });
}

/** Write both copies and return a region-scoped store over them. */
function makeStore({ desktop, own }) {
  const storagePath = join(root, `storage-${Math.random().toString(36).slice(2)}.json`);
  const ownPath = join(root, `own-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(storagePath, desktop, "utf8");
  writeFileSync(ownPath, own, "utf8");
  return new TraeCredentialStore({
    region: "cn",
    // Mirrors production: a TRAE SOLO CN install yields `edition: "solo"` for
    // BOTH copies (the desktop candidate's edition comes from which app dir it
    // was found in, and the plugin-owned copy stores it). They must agree, or
    // `traeAccountId` — which is `edition\0userId` — would treat one account's
    // two copies as two different accounts.
    edition: "solo",
    storagePath,
    ownPath,
    // Tests must never reach the real legacy single copy under the home dir.
    legacyOwnPath: join(root, "legacy-absent.json"),
    refresh: async () => {
      throw new Error("refresh must not be reached by readAll/current");
    },
  });
}

try {
  // --- 1. readAll picks the plugin-owned copy when it is the fresher one ---
  {
    const store = makeStore({
      desktop: storageDocument({
        accessExpiresAtMs: now - 10 * HOUR, // stale, rotated away
        refreshToken: "desktop-dead-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
      own: ownDocument({
        accessExpiresAtMs: now + 10 * HOUR, // the live copy
        refreshToken: "own-live-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
    });
    const all = await store.readAll();
    equal("readAll deduplicates one account", all.length, 1);
    equal("readAll takes the fresher plugin-owned token", all[0].accessToken, "own-access-token");
    equal("readAll takes the live refresh token", all[0].refreshToken, "own-live-refresh");
    equal("readAll keeps the account's region", regionOfCredential(all[0]), "cn");
  }

  // --- 2. A newer desktop copy still wins (the plugin copy can go stale too) ---
  {
    const store = makeStore({
      desktop: storageDocument({
        accessExpiresAtMs: now + 10 * HOUR,
        refreshToken: "desktop-fresh-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
      own: ownDocument({
        accessExpiresAtMs: now - 10 * HOUR,
        refreshToken: "own-stale-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
    });
    const all = await store.readAll();
    equal("readAll still deduplicates one account", all.length, 1);
    equal("readAll takes a fresher desktop token", all[0].accessToken, "desktop-access-token");
    equal("readAll takes the fresher desktop refresh token", all[0].refreshToken, "desktop-fresh-refresh");
  }

  // --- 3. Equal expiries are ambiguous, and either copy is safe ---
  {
    const same = now + 5 * HOUR;
    const store = makeStore({
      desktop: storageDocument({
        accessExpiresAtMs: same,
        refreshToken: "desktop-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
      own: ownDocument({
        accessExpiresAtMs: same,
        refreshToken: "own-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
    });
    const all = await store.readAll();
    equal("equal expiries keep a single account", all.length, 1);
    // Strict `>` (matching the DSH bundle) keeps the incumbent on a tie. A tie
    // means neither copy has been written since the other, so no rotation has
    // happened and BOTH refresh tokens are the original — either is safe. What
    // must not happen is two entries for one account.
    check(
      "equal expiries keep whichever copy was scanned first",
      all[0].accessToken === "desktop-access-token" || all[0].accessToken === "own-access-token",
      all[0].accessToken,
    );
  }

  // --- 4. A signed-out region still has no credentials ---
  {
    const store = makeStore({
      desktop: JSON.stringify({ "telemetry.machineId": "machine-a" }),
      own: JSON.stringify({ version: 1 }),
    });
    const all = await store.readAll();
    equal("a signed-out region lists no accounts", all.length, 0);
  }

  // --- 5. `current()` never refreshes ---
  {
    const store = makeStore({
      desktop: storageDocument({
        accessExpiresAtMs: now - 10 * HOUR, // expired
        refreshToken: "desktop-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
      own: ownDocument({
        accessExpiresAtMs: now - 10 * HOUR, // also expired
        refreshToken: "own-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
    });
    let threw;
    try {
      const credential = await store.current();
      check("current() returns the stored credential", credential !== undefined);
      // Both copies are expired here, so either one being returned proves the
      // point: `current()` answered without attempting the injected refresh.
      check(
        "current() does not refresh to obtain it",
        credential.accessToken === "own-access-token" || credential.accessToken === "desktop-access-token",
        credential.accessToken,
      );
    } catch (error) {
      threw = error;
    }
    check("current() never throws on an expired token", threw === undefined, threw?.message);
  }

  // --- 6. `resolve()` does refresh, which is why `check()` must not call it ---
  {
    const store = makeStore({
      desktop: storageDocument({
        accessExpiresAtMs: now - 10 * HOUR,
        refreshToken: "desktop-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
      own: ownDocument({
        accessExpiresAtMs: now - 10 * HOUR,
        refreshToken: "own-refresh",
        refreshExpiresAtMs: now + 1000 * HOUR,
      }),
    });
    // The injected refresh throws; resolve() must surface that as an error
    // rather than silently answering undefined — the distinction the new
    // `check()` relies on.
    let message;
    try {
      await store.resolve();
    } catch (error) {
      message = error.message;
    }
    check(
      "resolve() surfaces a failed refresh instead of hiding it",
      typeof message === "string" && message.includes("sign in again in Trae"),
      message ?? "resolve() returned without throwing",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`\n✓ ${passed} assertions passed`);
