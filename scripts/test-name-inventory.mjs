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
 *  - a point carrying a SKIP/TODO directive is UNPROVEN, not proven: its name exists but
 *    did not execute, so it is tracked as its own category rather than folded into
 *    MISSING. Policy over the two categories lives in `scripts/named-set-gate.mjs`,
 *  - a SKIP whose reason declares a capability (`missing runtime capability [<id>]: ...`,
 *    emitted by `tests/helpers/runtime-capabilities.ts`) is ATTRIBUTED, so the gate can
 *    name what the host was missing instead of guessing,
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
/** Splits a captured directive into its kind and its reason text. */
const DIRECTIVE_PARTS_RE = /^#\s*(SKIP|TODO)\b\s*(.*)$/i;
/**
 * A capability declaration inside a SKIP reason, as emitted by
 * `tests/helpers/runtime-capabilities.ts`. The id is the gate's attribution key; the
 * remainder is the human explanation printed beside it.
 */
const DECLARED_CAPABILITY_RE = /^missing runtime capability \[([a-z0-9][a-z0-9-]*)\]:\s*(.*)$/i;
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
 * Classify a captured TAP directive.
 *
 * `capability` is non-null only when the reason carries an explicit declaration, which is
 * what lets the gate say WHICH capability was missing. A TODO, or a SKIP with free-text
 * prose, classifies as un-attributed on purpose: the escape hatch must not be able to
 * cover a directive whose cause nobody declared.
 */
export function classifyDirective(directive) {
  if (typeof directive !== "string" || directive === "") {
    return { kind: null, capability: null, reason: "" };
  }
  const parts = DIRECTIVE_PARTS_RE.exec(directive.trim());
  if (parts === null) {
    return { kind: null, capability: null, reason: directive.trim() };
  }
  const kind = parts[1].toUpperCase();
  const reason = parts[2].trim();
  const declared = kind === "SKIP" ? DECLARED_CAPABILITY_RE.exec(reason) : null;
  if (declared === null) {
    return { kind, capability: null, reason };
  }
  return { kind, capability: declared[1].toLowerCase(), reason: declared[2].trim() };
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
 * Three outcomes, deliberately kept apart because they mean different things:
 *  - MISSING: a frozen name is nowhere in this run. A coverage regression.
 *  - UNPROVEN: the name ran as a test point but carried a SKIP/TODO directive, so it did
 *    not execute. Environment or authoring gap, not a coverage regression.
 *  - ADDED: live names with no frozen counterpart. Growing the suite must never fail.
 *
 * A name that appears BOTH proven and unproven (same name declared twice, one instance
 * skipped) counts as proven: at least one execution happened.
 *
 * `unprovenRows` accepts the collector's rows (`{ key, directive, kind, capability,
 * reason }`) or bare key strings. Omitting it reproduces the plain two-set difference.
 */
export function compareNamedTestSets(frozen, live, unprovenRows = []) {
  const frozenKeys = frozen instanceof Set ? frozen : new Set(frozen);
  const provenKeys = live instanceof Set ? live : new Set(live);

  const normalizedUnproven = [];
  const seenUnprovenKeys = new Set();
  for (const row of unprovenRows) {
    const normalized =
      typeof row === "string"
        ? { key: row, directive: "", kind: null, capability: null, reason: "" }
        : row;
    // A proven instance of the same name settles it; do not report it as unproven.
    if (provenKeys.has(normalized.key) || seenUnprovenKeys.has(normalized.key)) {
      continue;
    }
    seenUnprovenKeys.add(normalized.key);
    normalizedUnproven.push(normalized);
  }
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const unprovenFrozen = normalizedUnproven.filter((row) => frozenKeys.has(row.key)).sort(byKey);
  const unprovenAdded = normalizedUnproven.filter((row) => !frozenKeys.has(row.key)).sort(byKey);

  const missing = [...frozenKeys]
    .filter((key) => !provenKeys.has(key) && !seenUnprovenKeys.has(key))
    .sort();
  const added = [...new Set([...provenKeys, ...seenUnprovenKeys])]
    .filter((key) => !frozenKeys.has(key))
    .sort();

  return {
    missing,
    missingCount: missing.length,
    unprovenFrozen,
    unprovenFrozenCount: unprovenFrozen.length,
    unprovenAdded,
    unprovenAddedCount: unprovenAdded.length,
    provenFrozenCount: frozenKeys.size - missing.length - unprovenFrozen.length,
    added,
    addedCount: added.length,
    ok: missing.length === 0 && normalizedUnproven.length === 0
  };
}

/**
 * Line-oriented TAP collector. Feed it chunks in order; it tracks YAML diagnostic
 * blocks so their contents can never be mistaken for test points.
 *
 * Points are split at collection time into `provenKeys` (executed) and `unproven` (a
 * SKIP/TODO directive was attached). Both are keyed on the NAME alone, with the directive
 * stripped, so an unproven row still lines up with its frozen counterpart instead of
 * masquerading as a deletion plus an unrelated addition.
 */
export function createTapPointCollector() {
  const provenKeys = new Set();
  const unproven = [];
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
    const nameKey = buildKey(point.depth, point.status, point.name, null);
    if (point.directive === null) {
      provenKeys.add(nameKey);
      return;
    }
    const { kind, capability, reason } = classifyDirective(point.directive);
    unproven.push({ key: nameKey, directive: point.directive, kind, capability, reason });
  }

  function result() {
    return { provenKeys, unproven, pointCount, unterminatedYaml: openYamlIndent !== null };
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

/** Render one canonical key as a diagnostics row. */
export function formatKeyRow(key, indent = "  ") {
  const [depth, status, name] = key.split("\t");
  return `${indent}- depth=${depth} ${status} ${name}`;
}

/** Render the missing-row diagnostics: total count plus the first `limit` sorted rows. */
export function formatMissingReport(comparison, limit = MISSING_REPORT_LIMIT) {
  const lines = [
    `MISSING — ${comparison.missingCount} frozen named test row(s) absent from this run` +
      ` (showing up to ${limit}, sorted):`
  ];
  for (const key of comparison.missing.slice(0, limit)) {
    lines.push(formatKeyRow(key));
  }
  if (comparison.missingCount > limit) {
    lines.push(`  ... and ${comparison.missingCount - limit} more`);
  }
  return lines.join("\n");
}

/**
 * Group unproven rows by the capability they declared.
 *
 * Rows with no declared capability collect under a `null` capability, which the gate
 * treats as un-attributed and never downgrades.
 */
export function groupUnprovenByCapability(rows) {
  const groups = new Map();
  for (const row of rows) {
    // Attributed rows group by capability alone; un-attributed ones keep their distinct
    // directive text apart, so one stray TODO never hides behind another's prose.
    const groupKey =
      row.capability === null ? ` ${row.kind ?? ""} ${row.reason}` : row.capability;
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, {
        capability: row.capability,
        kind: row.kind,
        reason: row.reason,
        rows: [row]
      });
      continue;
    }
    existing.rows.push(row);
  }
  // Attributed groups first (alphabetical by capability), un-attributed ones last.
  return [...groups.values()].sort((a, b) => {
    const rank = Number(a.capability === null) - Number(b.capability === null);
    if (rank !== 0) {
      return rank;
    }
    return `${a.capability ?? ""}\t${a.kind ?? ""}\t${a.reason}`.localeCompare(
      `${b.capability ?? ""}\t${b.kind ?? ""}\t${b.reason}`
    );
  });
}

/**
 * Render unproven rows grouped by capability: the reason first, then the frozen names it
 * held back. Naming the rows is the point — "N tests were skipped" tells nobody which
 * contracts this run failed to prove.
 */
export function formatUnprovenReport(heading, rows, limit = MISSING_REPORT_LIMIT) {
  const lines = [`${heading} (showing up to ${limit} row(s) per capability, sorted):`];
  for (const group of groupUnprovenByCapability(rows)) {
    const label =
      group.capability === null
        ? `  no declared capability — ${group.kind ?? "directive"} ${group.reason || "(no reason given)"}`
        : `  capability [${group.capability}] — ${group.reason}`;
    lines.push(`${label} (${group.rows.length} row(s)):`);
    for (const row of group.rows.slice(0, limit)) {
      lines.push(formatKeyRow(row.key, "    "));
    }
    if (group.rows.length > limit) {
      lines.push(`    ... and ${group.rows.length - limit} more`);
    }
  }
  return lines.join("\n");
}
