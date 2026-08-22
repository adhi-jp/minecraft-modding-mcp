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
 * DETECTION is over CALLS, not lines. A line-at-a-time regex for
 * `.kill(...<signal name>)` read as if it covered the subject, but it missed
 * every other way to force-kill: the bare `kill(-pid, ...)` that the supervisor
 * itself uses, the numeric signal (`child.kill(9)` really does exit a child with
 * "signal <force signal>"), a signal held in a const, a call broken across
 * lines, and a shell `kill -9`. Each `kill(` token is therefore located in the
 * whole file, its argument list is read by balancing parentheses across
 * newlines, and the arguments are classified. Reporting stays per line so the
 * failure names a place to go.
 *
 * The forbidden signal name is assembled by concatenation below so this file's
 * own source never carries the literal — otherwise the guard would be unable
 * to describe what it forbids without tripping any repo-wide literal scan.
 */

const SCAN_ROOT = "tests/stdio";
const FORCE_KILL_SIGNAL = "SIG" + "KILL";
/** The same signal without its prefix, as `kill -KILL` / `kill -s KILL` spell it. */
const BARE_FORCE_SIGNAL = FORCE_KILL_SIGNAL.slice(3);
/** POSIX number of the same signal, as `child.kill(9)` / `kill -9` spell it. */
const FORCE_KILL_NUMBER = "9";
const ALLOW_MARKER = "allow-direct-sigkill";
/** A per-line hatch must state WHY, so a bare marker is not accepted. */
const ALLOW_LINE = new RegExp(`//\\s*${ALLOW_MARKER}:\\s*\\S`);

/**
 * A `kill(` CALL, whether reached through a member (`child.kill(`) or bare
 * (`kill(-pid, ...)`). The lookbehind rejects identifiers that merely end in
 * `kill`, so `stopAndKill(` and `awaitKill(` are not calls to kill.
 */
const KILL_CALL = /(?<![\w$])kill\s*\(/g;

/**
 * A shell force-kill inside a command string: `kill -9`, `kill -KILL`,
 * `kill -SIGKILL`, `kill -s KILL`. Assembled from the parts above so the
 * literal signal name still never appears in this file.
 */
const SHELL_FORCE_KILL = new RegExp(
  `(?<![\\w$-])kill\\s+-(?:${FORCE_KILL_NUMBER}|(?:s\\s+)?(?:SIG)?${BARE_FORCE_SIGNAL})(?![\\w])`
);

/** A `const`/`let`/`var` bound to the force signal, e.g. `const FORCE = "<signal>";`. */
const FORCE_SIGNAL_BINDING = new RegExp(
  `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=;]+)?=\\s*["'\`]${FORCE_KILL_SIGNAL}["'\`]`,
  "g"
);

/**
 * Upper bound on how far the paren-balancer will read for one call. A call that
 * does not close within this window is not a kill call worth reporting, and the
 * cap keeps an unbalanced file from turning the scan quadratic.
 */
const MAX_CALL_SCAN = 4000;

/** Argument text of every `kill(` call in `source`, with the offset it starts at. */
function killCallSites(source: string): Array<{ start: number; end: number; args: string }> {
  const sites: Array<{ start: number; end: number; args: string }> = [];
  const matcher = new RegExp(KILL_CALL.source, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length && i - open < MAX_CALL_SCAN; i += 1) {
      const char = source[i];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) {
      continue;
    }
    sites.push({ start: match.index, end, args: source.slice(open + 1, end) });
  }
  return sites;
}

/** Top-level arguments of an argument list, ignoring commas nested in (), [] or {}. */
function splitTopLevelArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of args) {
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Why this call is a force-kill, or undefined when it is not one. The reason is
 * carried into the failure message so a reader does not have to re-derive it.
 */
function forceKillReason(args: string, aliases: Set<string>): string | undefined {
  if (args.includes(FORCE_KILL_SIGNAL)) {
    return "signal name";
  }
  const parts = splitTopLevelArguments(args);
  const last = parts.at(-1);
  if (last === undefined) {
    return undefined;
  }
  if (last === FORCE_KILL_NUMBER) {
    return `numeric signal ${FORCE_KILL_NUMBER}`;
  }
  if (aliases.has(last)) {
    return "signal held in a const";
  }
  return undefined;
}

/**
 * Offending lines in one file, as `path:line: source`. A line is exempt when it
 * carries the marker itself, when the line directly above it does, or — for a
 * call spanning several lines — when any line the call covers carries it.
 */
function findOffenders(path: string, source: string): string[] {
  const lines = source.split("\n");
  // Offset of the first character of each line, so a call offset maps to a line.
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= position) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  };
  const exempt = (firstLine: number, lastLine: number): boolean => {
    if (ALLOW_LINE.test(lines[firstLine - 1] ?? "")) {
      return true;
    }
    for (let index = firstLine; index <= lastLine; index += 1) {
      if (ALLOW_LINE.test(lines[index] ?? "")) {
        return true;
      }
    }
    return false;
  };

  const aliases = new Set<string>();
  const bindings = new RegExp(FORCE_SIGNAL_BINDING.source, "g");
  let binding: RegExpExecArray | null;
  while ((binding = bindings.exec(source)) !== null) {
    if (binding[1]) {
      aliases.add(binding[1]);
    }
  }

  const offenders: Array<{ line: number; text: string }> = [];
  for (const site of killCallSites(source)) {
    const reason = forceKillReason(site.args, aliases);
    if (!reason) {
      continue;
    }
    const firstLine = lineOf(site.start);
    const lastLine = lineOf(site.end);
    if (exempt(firstLine, lastLine)) {
      continue;
    }
    offenders.push({ line: firstLine, text: `${(lines[firstLine] ?? "").trim()} [${reason}]` });
  }

  for (const [index, line] of lines.entries()) {
    if (!SHELL_FORCE_KILL.test(line)) {
      continue;
    }
    if (exempt(index, index)) {
      continue;
    }
    offenders.push({ line: index, text: `${line.trim()} [shell force-kill]` });
  }

  return offenders
    .sort((left, right) => left.line - right.line)
    .map(({ line, text }) => `${path}:${line + 1}: ${text}`);
}

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
    `f.ts:1: child.kill("${FORCE_KILL_SIGNAL}"); [signal name]`
  ]);
  assert.deepEqual(findOffenders("f.ts", `  t.after(() => session.child.kill("${FORCE_KILL_SIGNAL}"));`), [
    `f.ts:1: t.after(() => session.child.kill("${FORCE_KILL_SIGNAL}")); [signal name]`
  ]);
  assert.deepEqual(findOffenders("f.ts", `  process.kill(pid, "${FORCE_KILL_SIGNAL}");`), [
    `f.ts:1: process.kill(pid, "${FORCE_KILL_SIGNAL}"); [signal name]`
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
    [`f.ts:3: other.kill("${FORCE_KILL_SIGNAL}"); [signal name]`]
  );

  // Look-alikes: prose, data literals and non-force kills are not offences.
  assert.deepEqual(findOffenders("f.ts", `  // a bare ${FORCE_KILL_SIGNAL} orphans the worker`), []);
  assert.deepEqual(findOffenders("f.ts", `  const signal = "${FORCE_KILL_SIGNAL}";`), []);
  assert.deepEqual(findOffenders("f.ts", `  assert.equal(event.signal, "${FORCE_KILL_SIGNAL}");`), []);
  assert.deepEqual(findOffenders("f.ts", '  child.kill("SIGTERM");'), []);
});

test("the force-kill detector catches every shape a child can actually be force-killed with", () => {
  // Each row is a way to force-kill that the previous line-at-a-time
  // `.kill(...<signal name>)` regex did NOT catch. The middle two are real: the
  // supervisor's own teardown uses the bare form, and `child.kill(9)` was
  // verified to end a child with "exit code null signal <force signal>".
  const caught: Array<[string, string]> = [
    ["bare call with the signal name", `  kill(-pid, "${FORCE_KILL_SIGNAL}");`],
    ["numeric signal, single argument", "  child.kill(9);"],
    ["numeric signal, second argument", "  process.kill(pid, 9);"],
    ["numeric signal on a bare call", "  kill(-child.pid, 9);"],
    [
      "signal held in a const",
      `  const FORCE = "${FORCE_KILL_SIGNAL}";\n  child.kill(FORCE);`
    ],
    [
      "call split across lines",
      `  child.kill(\n    "${FORCE_KILL_SIGNAL}"\n  );`
    ],
    ["shell force-kill by number", "  execSync(`kill -9 ${pid}`);"],
    [`shell force-kill by name`, "  execSync(`kill -" + BARE_FORCE_SIGNAL + " ${pid}`);"],
    [`shell force-kill via -s`, "  execSync(`kill -s " + BARE_FORCE_SIGNAL + " ${pid}`);"]
  ];
  for (const [shape, source] of caught) {
    assert.equal(
      findOffenders("f.ts", source).length,
      1,
      `${shape} must be caught, source: ${JSON.stringify(source)}`
    );
  }

  // The broadened detector keeps the tight per-line hatch on every new shape.
  const marker = `// ${ALLOW_MARKER}: the restart contract IS the force kill`;
  assert.deepEqual(findOffenders("f.ts", `  child.kill(9); ${marker}`), []);
  assert.deepEqual(findOffenders("f.ts", `  ${marker}\n  kill(-pid, 9);`), []);
  assert.deepEqual(findOffenders("f.ts", "  execSync(`kill -9 ${pid}`); " + marker), []);
  // A multi-line call is exempted by a marker on ANY line it spans, because the
  // reader who annotated it cannot know which line the report will name.
  assert.deepEqual(
    findOffenders("f.ts", `  child.kill(\n    9 ${marker}\n  );`),
    []
  );
  // A bare marker still states no reason, on the new shapes too.
  assert.equal(findOffenders("f.ts", `  child.kill(9); // ${ALLOW_MARKER}:`).length, 1);

  // Widening detection must not start flagging non-kills.
  const ignored: Array<[string, string]> = [
    ["a graceful signal", '  child.kill("SIGTERM");'],
    ["a graceful numeric signal", "  child.kill(15);"],
    ["no signal at all", "  child.kill();"],
    ["an identifier that merely ends in kill", `  await stopAndKill(child, "${FORCE_KILL_SIGNAL}");`],
    ["a const binding with no call", `  const FORCE = "${FORCE_KILL_SIGNAL}";`],
    ["an unrelated const passed to kill", '  const TERM = "SIGTERM";\n  child.kill(TERM);'],
    ["a later timeout argument", "  setTimeout(() => child.kill(), 9);"],
    ["an assertion about the signal", `  assert.equal(exit.signal, "${FORCE_KILL_SIGNAL}");`]
  ];
  for (const [shape, source] of ignored) {
    assert.deepEqual(
      findOffenders("f.ts", source),
      [],
      `${shape} must not be flagged, source: ${JSON.stringify(source)}`
    );
  }

  // Known and accepted: the shell rule is textual, so PROSE naming the shell
  // force-kill is flagged too. The per-line hatch is the answer, and pinning it
  // here keeps the trade-off from being rediscovered as a bug.
  assert.equal(findOffenders("f.ts", "  // never reach for kill -9 here").length, 1);
  assert.deepEqual(
    findOffenders("f.ts", `  // never reach for kill -9 here ${marker}`),
    []
  );
});
