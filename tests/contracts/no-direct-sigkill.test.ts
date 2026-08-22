import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Contract: no wire-level stdio test force-kills a spawned child outright.
 *
 * The supervisor spawns its worker DETACHED (src/stdio-supervisor.ts) and only
 * terminates the worker's process group from its own shutdown path. Killing a
 * supervisor with an uncatchable signal therefore skips that path and leaves a
 * live ~125 MB worker behind; one full `npm test` run used to end with 20 of
 * them still resident. The teardown that does not leak lives in
 * tests/helpers/stdio-child-lifecycle.ts.
 *
 * The escape hatch is deliberately PER LINE, not per file: several suites mix
 * a handful of deliberate force-kills (the restart contract IS a force-kill)
 * with mechanical teardowns that must stay policed, so a file-level allowlist
 * would silently un-guard the mechanical ones.
 *
 * The forbidden signal name is assembled by concatenation below so this file's
 * own source never carries the literal — otherwise the guard would be unable
 * to describe what it forbids without tripping any repo-wide literal scan.
 */

const SCAN_ROOT = "tests/stdio";
const FORCE_KILL_SIGNAL = "SIG" + "KILL";
const ALLOW_MARKER = "allow-direct-sigkill";
/** Matches `.kill(..., "<force signal>")` and nothing else on the line. */
const DIRECT_FORCE_KILL = new RegExp(`\\.kill\\s*\\([^;]*${FORCE_KILL_SIGNAL}`);
/** A per-line hatch must state WHY, so a bare marker is not accepted. */
const ALLOW_LINE = new RegExp(`//\\s*${ALLOW_MARKER}:\\s*\\S`);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Offending lines in one file, as `path:line: source`. A line is exempt when
 * it carries the marker itself, or when the line directly above it does.
 */
function findOffenders(path: string, source: string): string[] {
  const lines = source.split("\n");
  const offenders: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!DIRECT_FORCE_KILL.test(line)) {
      continue;
    }
    if (ALLOW_LINE.test(line) || ALLOW_LINE.test(lines[index - 1] ?? "")) {
      continue;
    }
    offenders.push(`${path}:${index + 1}: ${line.trim()}`);
  }
  return offenders;
}

test("no wire-level stdio test force-kills a spawned child without a stated reason", async () => {
  const files = await walk(SCAN_ROOT);

  // Non-vacuity floor: a misrooted or empty walk would make the assertion
  // below pass while policing nothing.
  assert.ok(files.length >= 30, `the scan must cover >= 30 files under ${SCAN_ROOT}, saw ${files.length}`);
  assert.ok(
    files.includes(`${SCAN_ROOT}/stdio-supervisor-era-wire.test.ts`),
    "the scan must include the era wire suite"
  );

  const offenders: string[] = [];
  for (const path of files) {
    offenders.push(...findOffenders(path, await readFile(path, "utf8")));
  }

  assert.deepEqual(
    offenders,
    [],
    `tear spawned children down with stopSupervisor() from tests/helpers/stdio-child-lifecycle.ts ` +
      `(pass { leafProcess: true } for a worker spawned without a supervisor), or annotate the line ` +
      `with "// ${ALLOW_MARKER}: <reason>" when the force-kill is the behavior under test`
  );
});

test("the force-kill detector flags real kills, honors the per-line hatch, and ignores look-alikes", () => {
  const marker = `// ${ALLOW_MARKER}: the restart contract IS the force kill`;

  assert.deepEqual(findOffenders("f.ts", `  child.kill("${FORCE_KILL_SIGNAL}");`), [
    `f.ts:1: child.kill("${FORCE_KILL_SIGNAL}");`
  ]);
  assert.deepEqual(findOffenders("f.ts", `  t.after(() => session.child.kill("${FORCE_KILL_SIGNAL}"));`), [
    `f.ts:1: t.after(() => session.child.kill("${FORCE_KILL_SIGNAL}"));`
  ]);
  assert.deepEqual(findOffenders("f.ts", `  process.kill(pid, "${FORCE_KILL_SIGNAL}");`), [
    `f.ts:1: process.kill(pid, "${FORCE_KILL_SIGNAL}");`
  ]);

  // Hatch on the line itself, and on the line directly above it.
  assert.deepEqual(findOffenders("f.ts", `  child.kill("${FORCE_KILL_SIGNAL}"); ${marker}`), []);
  assert.deepEqual(findOffenders("f.ts", `  ${marker}\n  child.kill("${FORCE_KILL_SIGNAL}");`), []);
  // A bare marker with no reason does not exempt anything.
  assert.deepEqual(
    findOffenders("f.ts", `  child.kill("${FORCE_KILL_SIGNAL}"); // ${ALLOW_MARKER}:`).length,
    1
  );
  // The hatch reaches exactly one line, never the rest of the file.
  assert.deepEqual(
    findOffenders("f.ts", `  ${marker}\n  child.kill("${FORCE_KILL_SIGNAL}");\n  other.kill("${FORCE_KILL_SIGNAL}");`),
    [`f.ts:3: other.kill("${FORCE_KILL_SIGNAL}");`]
  );

  // Look-alikes: prose, data literals and non-force kills are not offences.
  assert.deepEqual(findOffenders("f.ts", `  // a bare ${FORCE_KILL_SIGNAL} orphans the worker`), []);
  assert.deepEqual(findOffenders("f.ts", `  const signal = "${FORCE_KILL_SIGNAL}";`), []);
  assert.deepEqual(findOffenders("f.ts", `  assert.equal(event.signal, "${FORCE_KILL_SIGNAL}");`), []);
  assert.deepEqual(findOffenders("f.ts", '  child.kill("SIGTERM");'), []);
});
