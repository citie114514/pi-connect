/**
 * Offline tests for the Qoder gateway's queue-wait policy.
 *
 * Qoder answers a queued request with `queueType` + `retryAfterSeconds`. The
 * retry ladder above it decides how long to wait before re-submitting, and that
 * decision has an observable effect on the user: re-submitting *early* is what
 * keeps a request queued. Measured 2026-11-11: the gateway kept answering the
 * same `queueType: p4, retryAfterSeconds: 60` for 25 minutes of polling, because
 * the old ladder multiplied the hint by 0.75..1.25 — roughly half of every
 * retry fired before the server's own deadline.
 *
 * The rules these tests pin down:
 *
 *   - the hint is a FLOOR, never undercut (jitter may only lengthen the wait);
 *   - no single sleep exceeds the gateway's own hint ceiling;
 *   - when the remaining budget cannot cover the hint, give up rather than
 *     submit a request that is certain to be re-queued;
 *   - a hintless failure (a transport blip) still gets a real retry.
 *
 * Run: node test-queue-wait.mjs
 */
import { queueWaitFor, QUEUE_WAIT_BUDGET_MS, QUEUE_WAIT_MAX_SLEEP_MS, QUEUE_WAIT_MIN_SLEEP_MS } from "./src/qoder/lib/upstream.js";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** A retryable queue error with the given hint. */
const queued = (seconds) => ({ retryable: true, retryAfterSeconds: seconds });

// --- 1. The hint is honoured, never undercut ---
{
  // The old shape returned `hint * (0.75 + rand*0.5)`, i.e. sometimes < hint.
  // Run it many times so a regression that reintroduces the undercut is caught
  // even though the current shape is deterministic-ish (jitter only adds).
  let undershot = 0;
  for (let i = 0; i < 500; i += 1) {
    const wait = queueWaitFor(queued(60), 0, 1);
    if (wait === undefined || wait < 60_000) undershot += 1;
  }
  check("a 60 s hint is never cut short (500 samples)", undershot === 0, `${undershot} samples waited < 60 s`);
}

// --- 2. Jitter only lengthens, never shortens ---
{
  let aboveHint = 0;
  for (let i = 0; i < 200; i += 1) {
    const wait = queueWaitFor(queued(10), 0, 1);
    if (wait !== undefined && wait > 10_000) aboveHint += 1;
  }
  check("jitter may lengthen the wait but the floor holds", aboveHint > 0, "no sample exceeded the hint, so jitter is gone");
}

// --- 3. One sleep never exceeds the gateway's ceiling ---
{
  // A ridiculous hint must not pin the turn for an hour.
  const wait = queueWaitFor(queued(3600), 0, 1);
  check(
    "an absurd hint is capped at QUEUE_WAIT_MAX_SLEEP_MS",
    wait === undefined || wait <= QUEUE_WAIT_MAX_SLEEP_MS,
    `waited ${wait}`,
  );
}

// --- 4. Budget too small to cover the hint: give up instead of guessing ---
{
  const waited = QUEUE_WAIT_BUDGET_MS - 1000; // 1 s left, hint asks 60 s
  const wait = queueWaitFor(queued(60), waited, 2);
  check(
    "no wait is returned when the budget cannot cover the hint",
    wait === undefined,
    `returned ${wait}; a 1 s wait would re-submit long before the server's deadline`,
  );
}

// --- 5. Budget exhausted outright ---
{
  check("an exhausted budget stops the ladder", queueWaitFor(queued(60), QUEUE_WAIT_BUDGET_MS + 1, 3) === undefined);
  check("a budget of exactly zero stops the ladder", queueWaitFor(queued(60), QUEUE_WAIT_BUDGET_MS, 3) === undefined);
}

// --- 6. A hintless failure still gets one more real attempt ---
{
  const wait = queueWaitFor({ retryable: true }, 0, 1);
  check("a hintless retryable failure still waits once", typeof wait === "number" && wait > 0, `got ${wait}`);
  check(
    "the hintless wait is at least the minimum sleep",
    typeof wait === "number" && wait >= QUEUE_WAIT_MIN_SLEEP_MS,
    `got ${wait}`,
  );
  check(
    "the hintless wait stays within the ceiling",
    typeof wait === "number" && wait <= QUEUE_WAIT_MAX_SLEEP_MS,
    `got ${wait}`,
  );
}

// --- 7. Non-retryable errors are never waited on ---
{
  check("a non-retryable error returns no wait", queueWaitFor({ retryable: false }, 0, 1) === undefined);
  check("an error with no retryable flag returns no wait", queueWaitFor({}, 0, 1) === undefined);
  check("undefined is tolerated", queueWaitFor(undefined, 0, 1) === undefined);
}

// --- 8. Escalation never undercuts the hint either ---
{
  // Late attempts escalate the backoff exponentially; whatever that produces
  // must still respect both the hint floor and the ceiling.
  let bad = 0;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const wait = queueWaitFor(queued(5), 0, attempt);
    if (wait !== undefined && wait < 5_000) bad += 1;
    if (wait !== undefined && wait > QUEUE_WAIT_MAX_SLEEP_MS) bad += 1;
  }
  check("late-attempt escalation respects floor and ceiling", bad === 0, `${bad} out-of-range waits`);
}

// --- 9. A hint longer than one sleep may take must not be shortened ---
{
  // The gateway's `retryAfterSeconds` is a floor. Sleeping the ceiling and
  // re-submitting early is exactly the polling that keeps a queue occupied, so
  // a hint above the ceiling has to end the turn rather than be clamped.
  for (const seconds of [61, 90, 120, 600]) {
    const wait = queueWaitFor(queued(seconds), 0, 1);
    check(
      `a ${seconds}s hint (above the ${QUEUE_WAIT_MAX_SLEEP_MS / 1000}s ceiling) ends the turn`,
      wait === undefined,
      `returned ${wait}; it would re-submit before the gateway's deadline`,
    );
  }
  // Exactly at the ceiling is still honourable.
  const atCeiling = queueWaitFor(queued(QUEUE_WAIT_MAX_SLEEP_MS / 1000), 0, 1);
  check(
    "a hint exactly at the ceiling still waits",
    typeof atCeiling === "number" && atCeiling >= QUEUE_WAIT_MAX_SLEEP_MS,
    `got ${atCeiling}`,
  );
  // And a hint below it is unaffected.
  const below = queueWaitFor(queued(10), 0, 1);
  check("a hint below the ceiling is unaffected", typeof below === "number" && below >= 10_000, `got ${below}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`✓ ${passed} assertions passed`);
