import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { longestDeclaredTestTimeoutMs, runWithIdleWatchdog } from "../helpers/suite-watchdog.ts";

/**
 * The manual stdio smoke used to wrap the supervisor timeout suite in a fixed 60 s
 * `execFile` budget, and killed a fully passing run once the suite grew past it. The
 * replacement watches for IDLENESS and sizes itself from the suite's own declared per-test
 * timeouts, so these tests pin both halves of that: the derivation, and the distinction
 * between "slow" (fine) and "wedged" (fatal).
 */

const SUPERVISOR_TIMEOUT_SUITE = "tests/stdio/stdio-supervisor-timeout.test.ts";

test("the watchdog budget is derived from the suite's own longest declared per-test timeout", async () => {
  const source = await readFile(SUPERVISOR_TIMEOUT_SUITE, "utf8");
  const longest = longestDeclaredTestTimeoutMs(source);

  assert.equal(typeof longest, "number", "the supervisor timeout suite declares per-test budgets");
  assert.ok(
    (longest ?? 0) >= 20_000,
    `the derived budget must track the suite: longest declared timeout is ${longest}`
  );

  // The declared-budget SUM is what the old fixed cap contradicted: seven tests are
  // allowed far more than 60 s in total, so any aggregate wall-clock cap is a cliff.
  const declaredSum = [...source.matchAll(/\btimeout:\s*([0-9][0-9_]*)/g)]
    .map((match) => Number(match[1].replace(/_/g, "")))
    .reduce((sum, value) => sum + value, 0);
  assert.ok(
    declaredSum > 60_000,
    `the suite's own declared budgets (${declaredSum} ms) already exceed the retired 60 s cap`
  );

  // Only real per-test options count. A `timeout?:` type member or a `timeoutMs` local is
  // not a budget, and mistaking one for a budget would resize the watchdog by accident.
  assert.equal(
    longestDeclaredTestTimeoutMs("type T = { timeout?: number }; const timeoutMs = 900_000;"),
    null
  );
  assert.equal(longestDeclaredTestTimeoutMs("test('a', { timeout: 1_500 }, () => {})"), 1_500);
  assert.equal(longestDeclaredTestTimeoutMs("no timeouts here"), null);
});

test("the idle watchdog lets a slow but progressing run finish", async () => {
  // Total runtime deliberately exceeds the idle budget several times over: duration is not
  // what is being policed.
  const script =
    "let n=0;const t=setInterval(()=>{process.stdout.write(`tick ${++n}\\n`);" +
    "if(n===8){clearInterval(t);}},120);";

  const result = await runWithIdleWatchdog({
    command: process.execPath,
    args: ["-e", script],
    idleBudgetMs: 500,
    label: "slow-but-progressing probe"
  });

  assert.match(result.output, /tick 8/, "the child must have run to completion");
  assert.ok(
    result.elapsedMs > 500,
    `the run outlived the idle budget without being killed (${result.elapsedMs} ms)`
  );
});

test("the idle watchdog kills a wedged run and says so", async () => {
  const script = "process.stdout.write('starting\\n');setInterval(()=>{},1000);";

  await assert.rejects(
    () =>
      runWithIdleWatchdog({
        command: process.execPath,
        args: ["-e", script],
        idleBudgetMs: 400,
        label: "wedged probe"
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /wedged probe produced no output for 400 ms/);
      assert.match(message, /starting/, "the failure must carry the output captured so far");
      return true;
    }
  );
});

test("the idle watchdog reports a non-zero exit without blaming idleness", async () => {
  await assert.rejects(
    () =>
      runWithIdleWatchdog({
        command: process.execPath,
        args: ["-e", "process.stdout.write('boom\\n');process.exit(3);"],
        idleBudgetMs: 10_000,
        label: "failing probe"
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /failing probe exited with code=3/);
      assert.doesNotMatch(message, /wedged/);
      return true;
    }
  );
});
