import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";
import { stopSupervisor } from "../helpers/stdio-child-lifecycle.ts";

/**
 * The shared teardown ladder in tests/helpers/stdio-child-lifecycle.ts has five
 * rungs, and every one of its ~40 real call sites is a supervisor that exits on
 * stdin EOF — so rung 3 always wins and the SIGTERM and force-kill rungs below
 * it have never actually run. Their budgets were also tightened from the
 * inlined predecessors' 10 s to 2 s, which means the first execution of that
 * untested code would otherwise happen the day a supervisor needs longer than
 * 2 s to drain.
 *
 * These tests drive the ladder with synthetic children that refuse each rung in
 * turn, so the escalation past a closed stdin, and past an ignored SIGTERM, is
 * observed rather than assumed.
 */

/** A child that survives stdin EOF; `onTerm` decides how it answers SIGTERM. */
function spawnStubbornChild(onTerm: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      "-e",
      `process.on('SIGTERM', () => { ${onTerm} });` +
        // Resume and then ignore EOF: a referenced interval keeps the event
        // loop alive, so a closed stdin cannot end this process.
        "process.stdin.resume();process.stdin.on('end', () => {});" +
        "setInterval(() => {}, 1000);" +
        "process.stdout.write('ready\\n');"
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
}

/** Resolves once the child has installed its handlers and said so. */
async function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the synthetic child never reported ready")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test("the shared teardown escalates to SIGTERM when a child outlives its closed stdin", { timeout: 20_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  // Exit code 42 is reachable ONLY from the SIGTERM handler, so observing it
  // proves the ladder really sent the signal instead of stopping at rung 3.
  const child = spawnStubbornChild("process.exit(42);");
  t.after(() => {
    // allow-direct-sigkill: synthetic leaf child with no descendants, and the ladder itself is under test
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  });
  await waitForChildReady(child);

  await stopSupervisor(child, { graceMs: 500, termMs: 500 });

  assert.equal(child.signalCode, null, "the child answered SIGTERM itself, so no signal should be recorded");
  assert.equal(child.exitCode, 42, "the child must have left through its SIGTERM handler");
});

test("the shared teardown force-kills a child that ignores both its closed stdin and SIGTERM", { timeout: 20_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const child = spawnStubbornChild("/* deliberately ignored */");
  t.after(() => {
    // allow-direct-sigkill: synthetic leaf child with no descendants, and the ladder itself is under test
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  });
  await waitForChildReady(child);

  await stopSupervisor(child, { graceMs: 500, termMs: 500 });

  assert.equal(child.exitCode, null, "an uncatchable kill leaves no exit code");
  assert.equal(child.signalCode, "SIGKILL", "the last rung must force the child down");
});

test("the shared teardown still escalates when the child's stdin is already torn down", { timeout: 20_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  // A child that tore its own stdin down answers `end()` with an error event.
  // Unhandled that would crash the test runner; swallowed without falling
  // through, the child would simply never be collected.
  const child = spawnStubbornChild("process.exit(42);");
  t.after(() => {
    // allow-direct-sigkill: synthetic leaf child with no descendants, and the ladder itself is under test
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  });
  await waitForChildReady(child);
  child.stdin.destroy();

  await stopSupervisor(child, { graceMs: 500, termMs: 500 });

  assert.equal(child.exitCode, 42, "a torn-down stdin must not skip the signal rungs");
});
