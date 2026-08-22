/**
 * Named-test set regression helper.
 *
 * `tests/fixtures/premigration/test-list.txt` is a frozen NAMED-SET baseline: one
 * canonical key per TAP test point captured before the migration. The inventory
 * contract test only pins file/declaration COUNTS, so deleting or renaming an
 * inherited test while adding an unrelated one keeps those counts green. This module
 * supplies the set-difference that closes that false-green: `npm test` emits TAP to a
 * temp file alongside its normal spec output in the SAME run, and — only after a green
 * suite — checks that every frozen key is still present.
 *
 * Semantics:
 *  - comparison is `frozen - live`; ADDITIONS are expected and never fail,
 *  - a SKIP/TODO directive is a failure: a skipped test is a silently missing name,
 *  - only the volatile point index and an inline timing decoration are normalized away.
 *
 * Pure module: importing it performs no I/O and mutates no global state.
 */

import { createReadStream } from "node:fs";

/** A TAP test point: `<indent>ok <n> - <description>`. */
const TAP_POINT_RE = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/;
/** A frozen fixture row: `<depth>\t<status>\t<description>`. */
const FROZEN_ROW_RE = /^(\d+)\t(ok|not ok)\t(.*)$/;
/** Volatile timing decoration some reporters append inline. Trailing position only. */
const TIMING_DECORATION_RE = /\s*#\s*(?:time=[0-9]+(?:\.[0-9]+)?ms|duration_ms=[0-9]+(?:\.[0-9]+)?)\s*$/;
/** A TAP directive. Deliberately narrow: a general `# ...` suffix is part of the name. */
const DIRECTIVE_RE = /\s+(#\s*(?:SKIP|TODO)\b.*)$/i;
/** Legacy spec-local prefix stripped from live names during the migration. Frozen rows only. */
const LEGACY_PREFIX_RE = /^F-[0-9]{2}: /;
/** TAP nests subtests by four spaces per level. */
const TAP_INDENT_WIDTH = 4;
/** How many missing rows a failure report lists. */
export const MISSING_REPORT_LIMIT = 20;

function leadingSpaceCount(line) {
  return line.length - line.trimStart().length;
}

/**
 * Split a raw TAP description into its name and its directive.
 *
 * The directive is separated FIRST so that later name-only handling (the legacy prefix
 * strip) can never reach into a directive.
 */
function splitDescription(rawDescription) {
  const withoutTiming = rawDescription.trimEnd().replace(TIMING_DECORATION_RE, "").trimEnd();
  const directiveMatch = DIRECTIVE_RE.exec(withoutTiming);
  if (directiveMatch === null) {
    return { name: withoutTiming, directive: null };
  }
  return {
    name: withoutTiming.slice(0, directiveMatch.index).trimEnd(),
    directive: directiveMatch[1].trimEnd()
  };
}

function buildKey(depth, status, name, directive) {
  const described = directive === null ? name : `${name} ${directive}`;
  return `${depth}\t${status}\t${described}`;
}

/**
 * Parse one line of TAP output into a canonical test point, or null when the line is
 * not a test point (plan lines, `# Subtest:` comments, YAML diagnostics, summaries).
 */
export function parseTapPointLine(line) {
  if (typeof line !== "string") {
    return null;
  }
  const match = TAP_POINT_RE.exec(line);
  if (match === null) {
    return null;
  }
  const depth = Math.floor(match[1].length / TAP_INDENT_WIDTH);
  const status = match[2];
  const { name, directive } = splitDescription(match[3]);
  return { depth, status, name, directive, key: buildKey(depth, status, name, directive) };
}

/**
 * Parse the frozen fixture into a canonical key set.
 *
 * Throws on an empty fixture, a malformed row, or a duplicate key — a baseline that
 * cannot be trusted must never silently weaken the gate.
 */
export function parseFrozenNamedSet(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("frozen named-set fixture is empty");
  }
  const keys = new Set();
  const directiveRows = [];
  let rowCount = 0;
  let prefixStrippedCount = 0;
  let lineNumber = 0;
  for (const rawLine of text.split("\n")) {
    lineNumber += 1;
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = FROZEN_ROW_RE.exec(line);
    if (match === null) {
      throw new Error(
        `malformed frozen named-set row at line ${lineNumber}: ${JSON.stringify(line)}`
      );
    }
    const depth = Number(match[1]);
    const status = match[2];
    const { name: describedName, directive } = splitDescription(match[3]);
    let name = describedName;
    if (LEGACY_PREFIX_RE.test(name)) {
      name = name.replace(LEGACY_PREFIX_RE, "");
      prefixStrippedCount += 1;
    }
    const key = buildKey(depth, status, name, directive);
    if (keys.has(key)) {
      throw new Error(`duplicate frozen named-set key at line ${lineNumber}: ${JSON.stringify(key)}`);
    }
    keys.add(key);
    rowCount += 1;
    if (directive !== null) {
      directiveRows.push(key);
    }
  }
  if (rowCount === 0) {
    throw new Error("frozen named-set fixture contains no rows");
  }
  return { keys, rowCount, prefixStrippedCount, directiveRows };
}

/**
 * Compare the frozen baseline against the live run as `frozen - live`.
 *
 * Added rows are reported for information only: growing the suite must never fail.
 */
export function compareNamedTestSets(frozen, live) {
  const frozenKeys = frozen instanceof Set ? frozen : new Set(frozen);
  const liveKeys = live instanceof Set ? live : new Set(live);
  const missing = [...frozenKeys].filter((key) => !liveKeys.has(key)).sort();
  const added = [...liveKeys].filter((key) => !frozenKeys.has(key)).sort();
  return {
    missing,
    missingCount: missing.length,
    added,
    addedCount: added.length,
    ok: missing.length === 0
  };
}

/**
 * Line-oriented TAP collector. Feed it chunks in order; it tracks YAML diagnostic
 * blocks so their contents can never be mistaken for test points.
 */
export function createTapPointCollector() {
  const keys = new Set();
  const directiveRows = [];
  let pointCount = 0;
  let buffer = "";
  let openYamlIndent = null;

  function consumeLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (openYamlIndent !== null) {
      if (/^\s*\.\.\.\s*$/.test(line) && leadingSpaceCount(line) === openYamlIndent) {
        openYamlIndent = null;
      }
      return;
    }
    if (/^\s*---\s*$/.test(line)) {
      openYamlIndent = leadingSpaceCount(line);
      return;
    }
    const point = parseTapPointLine(line);
    if (point === null) {
      return;
    }
    pointCount += 1;
    keys.add(point.key);
    if (point.directive !== null) {
      directiveRows.push(point.key);
    }
  }

  function result() {
    return { keys, directiveRows, pointCount, unterminatedYaml: openYamlIndent !== null };
  }

  return {
    write(chunk) {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    },
    end() {
      if (buffer !== "") {
        consumeLine(buffer);
        buffer = "";
      }
      return result();
    },
    result
  };
}

/** Stream a TAP file through the collector. */
export async function collectNamedSetFromTapFile(path) {
  const collector = createTapPointCollector();
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) {
    collector.write(chunk);
  }
  return collector.end();
}

/** Render the missing-row diagnostics: total count plus the first `limit` sorted rows. */
export function formatMissingReport(comparison, limit = MISSING_REPORT_LIMIT) {
  const lines = [
    `${comparison.missingCount} frozen named test row(s) missing from this run` +
      ` (showing up to ${limit}, sorted):`
  ];
  for (const key of comparison.missing.slice(0, limit)) {
    const [depth, status, name] = key.split("\t");
    lines.push(`  - depth=${depth} ${status} ${name}`);
  }
  if (comparison.missingCount > limit) {
    lines.push(`  ... and ${comparison.missingCount - limit} more`);
  }
  return lines.join("\n");
}
