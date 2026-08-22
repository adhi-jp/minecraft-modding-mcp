import { spawn } from "node:child_process";

/**
 * Idle watchdog for a spawned test suite.
 *
 * The manual stdio smoke used to wrap a whole suite in a fixed 60-second `execFile`
 * budget. That is an aggregate wall-clock assertion on a suite whose content grows, so it
 * fails as soon as the suite legitimately gets longer — which it did: seven tests whose
 * OWN declared per-test timeouts already sum to 112 s were being killed at 60 s with every
 * one of them passing. Raising the number just moves the cliff.
 *
 * What the cap was actually for is catching a WEDGED runner — a child that stops making
 * progress and never exits. That is idleness, not duration. A healthy `node --test` child
 * emits a line as each test finishes, so "no output for longer than the slowest test could
 * possibly take" is the honest signal, and it rescales by itself when tests are added,
 * removed, or retimed.
 */

/** Matches a `{ timeout: 20_000 }` test option. Deliberately misses `timeout?:` type
 *  members and `timeoutMs = ...` locals, which are not per-test budgets. */
const DECLARED_TEST_TIMEOUT_RE = /\btimeout:\s*([0-9][0-9_]*)/g;

/**
 * The largest per-test timeout a suite declares in its own source.
 *
 * The MAX is used rather than the sum on purpose: a sum would have to understand that
 * `for (const framing of [...]) test(...)` declares one test per iteration, and a
 * miscounted sum silently reintroduces the cliff. The max is loop-independent, and idle
 * time is what the watchdog measures anyway.
 *
 * Returns null when the suite declares no explicit timeout, leaving the choice of a
 * default to the caller.
 */
export function longestDeclaredTestTimeoutMs(source: string): number | null {
  const declared = [...source.matchAll(DECLARED_TEST_TIMEOUT_RE)].map((match) =>
    Number(match[1].replace(/_/g, ""))
  );
  const usable = declared.filter((value) => Number.isFinite(value) && value > 0);
  return usable.length === 0 ? null : Math.max(...usable);
}

export type IdleWatchdogRun = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long the child may produce NO output before it is treated as wedged. */
  idleBudgetMs: number;
  /** Used in error messages so a failure says which suite wedged. */
  label: string;
};

export type IdleWatchdogResult = {
  output: string;
  elapsedMs: number;
};

/** Keep failure messages useful without dumping a whole suite log. */
function tail(output: string, lines = 40): string {
  const all = output.trimEnd().split("\n");
  return all.length <= lines ? all.join("\n") : all.slice(-lines).join("\n");
}

/**
 * Run a child to completion, failing only if it stops producing output for longer than
 * `idleBudgetMs` or exits non-zero. There is no cap on total duration by design.
 */
export function runWithIdleWatchdog(run: IdleWatchdogRun): Promise<IdleWatchdogResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      env: run.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let wedged = false;
    let timer: NodeJS.Timeout | undefined;

    const disarm = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const arm = (): void => {
      disarm();
      timer = setTimeout(() => {
        wedged = true;
        child.kill("SIGKILL");
      }, run.idleBudgetMs);
      timer.unref?.();
    };
    const observe = (chunk: unknown): void => {
      output += String(chunk);
      arm();
    };

    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    arm();

    child.once("error", (error) => {
      disarm();
      reject(error);
    });
    child.once("close", (code, signal) => {
      disarm();
      const elapsedMs = Date.now() - startedAt;
      if (wedged) {
        reject(
          new Error(
            `${run.label} produced no output for ${run.idleBudgetMs} ms and was killed as ` +
              `wedged after ${elapsedMs} ms.\n${tail(output)}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${run.label} exited with code=${code} signal=${signal} after ${elapsedMs} ms.\n` +
              tail(output)
          )
        );
        return;
      }
      resolve({ output, elapsedMs });
    });
  });
}
