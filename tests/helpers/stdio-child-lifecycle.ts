import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Shared teardown for spawned stdio children (supervisors and bare workers).
 *
 * Every wire-level suite used to end its child with a bare SIGKILL. That is a
 * process LEAK for a supervisor: the supervisor spawns its worker detached
 * (src/stdio-supervisor.ts, `detached: true` on POSIX) and only reaps the
 * worker's process group from its own shutdown path, so a SIGKILL to the
 * supervisor leaves the worker running with nobody to collect it. One full
 * `npm test` run left 20 such orphans on the reference machine.
 *
 * The orphan-free order is therefore:
 *
 *   1. already exited            -> nothing to do
 *   2. leafProcess               -> immediate SIGKILL (see below)
 *   3. end stdin                 -> the supervisor's client-closed shutdown
 *                                   path (handleClientClosed -> shutdown)
 *                                   terminates the detached worker group
 *   4. SIGTERM after graceMs     -> the supervisor's signal handler, same path
 *   5. SIGKILL after termMs      -> last resort; only reachable when the two
 *                                   cooperative rungs both failed
 *
 * `leafProcess: true` is for a DIRECT worker spawned without a supervisor: it
 * has no descendants, so nothing can be orphaned, and routing it through the
 * cooperative rungs would only add a multi-second stall per test.
 *
 * The rung budgets are deliberately 2 s each rather than the 10 s the inlined
 * predecessors used: this runs inside `t.after`, and the shortest suite that
 * calls it declares `{ timeout: 5_000 }`.
 */

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_TERM_MS = 2_000;

export type StopSupervisorOptions = {
  /** A worker spawned WITHOUT a supervisor: no descendants, so kill it outright. */
  leafProcess?: boolean;
  /** How long the stdin-close rung is given before SIGTERM. */
  graceMs?: number;
  /** How long the SIGTERM rung is given before SIGKILL. */
  termMs?: number;
};

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child is gone, false if `timeoutMs` elapsed first. */
async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return hasExited(child);
}

export async function stopSupervisor(
  child: ChildProcessWithoutNullStreams,
  options: StopSupervisorOptions = {}
): Promise<void> {
  if (hasExited(child)) return;

  if (options.leafProcess === true) {
    child.kill("SIGKILL");
    return;
  }

  // A child that already tore its own stdin down answers `end()` with an
  // EPIPE 'error' event; unhandled, that would crash the test runner instead
  // of falling through to the signal rungs below.
  child.stdin.on("error", () => {
    // The escalation ladder is the real teardown signal, not this stream.
  });
  try {
    child.stdin.end();
  } catch {
    // A torn-down stdin must not skip the later rungs.
  }

  if (await waitForExit(child, options.graceMs ?? DEFAULT_GRACE_MS)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, options.termMs ?? DEFAULT_TERM_MS)) return;
  child.kill("SIGKILL");
  await waitForExit(child, options.termMs ?? DEFAULT_TERM_MS);
}
