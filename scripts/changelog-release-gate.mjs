/**
 * Release CHANGELOG gate: policy and rendering.
 *
 * `CHANGELOG.md` is an end-user document (AGENTS.md → CHANGELOG Content Rules). While work
 * is in flight, `## [Unreleased]` is allowed to carry work-log detail; the release cut is
 * where that detail MUST be rewritten for a reader with no access to this repository. The
 * RELEASE-MATURITY audit below (`auditChangelog`) polices exactly that boundary and runs on a
 * DATED release section only — the content rules it enforces are meaningless before the cut.
 *
 * A second, narrower audit (`auditUnreleased`) covers `## [Unreleased]`. It applies only the
 * three structural checks that hold regardless of maturity — `duplicate-section`,
 * `unattributed-text`, `empty-entry` — and shares this module's one parser with the dated
 * audit so the two can never disagree about what a section contains. See
 * `auditUnreleasedSection` for what it deliberately leaves out and why.
 *
 * The release-maturity audit is a floor, not a reviewer. It detects the two failure shapes
 * that are mechanically decidable and that this repository has actually shipped:
 *
 *  1. INTERNAL REFERENCE — a released entry naming something only a contributor can resolve:
 *     a `tests/` or `src/` path, a `.test.ts` file, a fixture or golden, or a proof-of-work
 *     marker such as `Verification:` / `Pinned by`. These separate cleanly: across every
 *     dated section in this file's history, only the sections that were promoted verbatim
 *     from a work log trip them. There is no allowance and no escape hatch — an entry that
 *     needs a repository path to make sense has not been rewritten for the reader yet.
 *
 *  2. OVERSIZED ENTRY — a single entry past `RELEASE_ENTRY_MAX_CHARS`. Length is a coarse
 *     proxy and deliberately loose: the threshold sits above the longest entry any
 *     properly-cut release in this file has needed, so it fires on work-log dumps rather
 *     than on genuinely dense breaking-change entries. It is a backstop for prose that
 *     carries no forbidden marker, not a style rule.
 *
 * What it CANNOT do: an accurate, internal, repository-shaped narrative that avoids every
 * marker and stays under the length ceiling passes. Passing this gate is therefore not
 * evidence that a section is end-user-ready — the restructuring duty in AGENTS.md stands on
 * its own, and this module only makes the cheapest violations impossible to ship.
 *
 * Pure by design — no I/O, no `process.exit` — so every branch is reachable from a unit test
 * with synthetic input. `scripts/check-changelog.mjs` owns the file reads and the exit code.
 */

/**
 * Longest single entry permitted in a dated release section.
 *
 * Derived from this repository's own history rather than chosen: the longest entry in a
 * release section that was cut properly is 1,275 characters, while the sections promoted
 * verbatim from a work log reached 2,315. 1,500 leaves the former room to grow and still
 * catches the latter.
 */
export const RELEASE_ENTRY_MAX_CHARS = 1500;

/**
 * Markers that a released entry must not contain.
 *
 * Each `pattern` is matched against the entry text. `why` is printed verbatim to the author,
 * so it states the reader-facing problem, not the regex.
 */
export const FORBIDDEN_MARKERS = [
  {
    id: "test-path",
    // A negative lookbehind on word characters, not a fixed set of allowed
    // prefixes: the earlier allowlist ([\s`("'[) plus start-of-string) omitted
    // `/` and `.`, so "./tests/foo" and "packages/tests/foo" — the ordinary way
    // to write a relative or nested repository path in prose — slipped through
    // undetected. Only a preceding letter/digit/underscore still blocks the
    // match, so a real word that merely ends in "tests" (protests, contests)
    // is still spared.
    pattern: /(?<![A-Za-z0-9_])tests\//i,
    why: "names a path under tests/ — the reader cannot open this repository's test tree",
  },
  {
    id: "source-path",
    pattern: /(?<![A-Za-z0-9_])src\//i,
    why: "names a path under src/ — describe the observable behavior, not the file that implements it",
  },
  {
    id: "script-path",
    pattern: /(?<![A-Za-z0-9_])scripts\//i,
    why: "names a repository script — build tooling is not part of the published surface",
  },
  {
    id: "workflow-path",
    pattern: /(?<![A-Za-z0-9_])\.github\//i,
    why: "names a CI workflow — CI/CD changes are excluded from CHANGELOG.md entirely",
  },
  {
    id: "build-output-path",
    pattern: /(?<![A-Za-z0-9_])(?:dist|coverage)\//i,
    why: "names build or coverage output — describe what the installed package does instead",
  },
  {
    id: "test-file",
    pattern: /\.(?:test|perf)\.ts\b/i,
    why: "names a test file — a released entry must stand without pointing at the suite that proves it",
  },
  {
    id: "fixture",
    pattern: /\b(?:fixtures?|goldens?)\b/i,
    why: "names a fixture or golden file — internal verification material, even when no path is given",
  },
  {
    id: "proof-marker",
    pattern: /\bverification:|\b(?:pinned|guarded) by\b/i,
    why: "carries a proof-of-work marker — evidence belongs in the commit body or PR notes, not the release notes",
  },
];

const RELEASE_HEADING = /^## \[(?<version>[^\]]+)\](?<rest>.*)$/;
const DATED_HEADING_TAIL = /^\s+-\s+\d{4}-\d{2}-\d{2}\s*$/;
const MARKDOWN_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BULLET = /^(?<indent>[ \t]*)(?<marker>[-*+]|\d{1,9}[.)])(?:(?<gap>[ \t]+)(?<text>.*\S)[ \t]*|[ \t]*)$/;
const INDENTED = /^[ \t]+(?<text>\S.*\S|\S)[ \t]*$/;
const INVISIBLE_BLOCK = /^ {0,3}(?:\[[^\]]+\]:|<!--)/;
const FENCE_OPEN = /^(?<indent> {0,3})(?<fence>`{3,}|~{3,})(?<info>.*)$/;
const FENCE_CLOSE = /^ {0,3}(?<fence>`{3,}|~{3,})[ \t]*$/;

/** Column width of leading whitespace, counting a tab as the next multiple of four. */
function indentWidth(whitespace) {
  let width = 0;
  for (const character of whitespace) width = character === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/**
 * Approximate what a reader sees, so a marker cannot be split by markup that renders away.
 *
 * ``Verifi`cation:``` and `tests&#47;helper.json` render as the forbidden token but do not
 * contain it as source bytes. This is not a Markdown renderer and does not try to be one; it
 * strips the constructs that can sit INSIDE a word — code-span delimiters, backslash
 * escapes, HTML comments — and decodes the character references that appear in the markers
 * themselves. Markers are matched against the source text and this rendering, so neither
 * form escapes.
 */
export function renderedText(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`+/g, "")
    .replace(/\\(?=[!-\/:-@[-`{-~])/g, "")
    .replace(/&#0*47;|&sol;/gi, "/")
    .replace(/&#0*58;|&colon;/gi, ":")
    .replace(/&#0*46;|&period;/gi, ".");
}

/**
 * Split `markdown` into lines with CRLF normalized away and fenced code blocks marked.
 *
 * A release entry never lives inside a fence, and a fence can legally contain text that
 * looks like a heading or a bullet, so marking fenced lines once — here — keeps heading
 * discovery, section extraction and version listing from disagreeing about what is
 * structure and what is sample content.
 *
 * Opener and closer are checked against CommonMark's conditions rather than a loose "line
 * starts with backticks" test, because both directions of the loose version are wrong: a
 * four-space-indented run is an indented code block and opens nothing, so treating it as a
 * fence would hide every violation after it, and a run followed by text is not a closer, so
 * accepting it would end the block early and audit sample content as prose.
 *
 * One deliberate deviation: an INDENTED fence — one opened inside a list item — is closed by
 * a release heading at column 0. Under CommonMark an unclosed fence runs to the end of the
 * document, so a single unterminated fence inside an item would swallow every later release
 * section and the gate would report a clean file because it could no longer see them. A fence
 * opened at column 0 is a top-level code block and keeps the standard behavior, so a sample
 * that legitimately shows a release heading is still treated as sample content.
 *
 * KNOWN LIMITATION, accepted rather than fixed: that deviation misreads one shape. An
 * indented fence whose CONTENT is written at column 0 — the fence markers indented into a
 * list item, the sample lines not — ends at the first sample line that looks like a heading,
 * and the gate then audits that line as a real second section, reporting `duplicate-section`.
 * Both audits inherit it, since both read this one parser; it is not specific to
 * `## [Unreleased]`. Repairing it means giving up the column-0 escape above, and the failure
 * that escape prevents — one stray fence blinding the gate to every later release section —
 * is far worse than a false positive on a malformed sample. The correctly indented form
 * (markers AND content indented to the item's content column) parses cleanly and is pinned by
 * test; write samples that way.
 */
function scanLines(markdown) {
  const raw = markdown.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  let open = null;

  for (const text of raw) {
    if (open !== null && open.indent > 0 && RELEASE_HEADING.test(text)) open = null;

    if (open === null) {
      const opener = FENCE_OPEN.exec(text);
      const backtickInfo = opener && opener.groups.fence[0] === "`" && opener.groups.info.includes("`");
      if (opener && !backtickInfo) {
        open = { fence: opener.groups.fence, indent: indentWidth(opener.groups.indent) };
        lines.push({ text, fenced: true, fenceIndent: open.indent });
        continue;
      }
      lines.push({ text, fenced: false, fenceIndent: 0 });
      continue;
    }

    lines.push({ text, fenced: true, fenceIndent: open.indent });
    const closer = FENCE_CLOSE.exec(text);
    if (closer && closer.groups.fence[0] === open.fence[0] && closer.groups.fence.length >= open.fence.length) {
      open = null;
    }
  }

  return lines;
}

/** List the dated release versions in document order. Fenced sample headings are ignored. */
export function listReleaseVersions(markdown) {
  const versions = [];
  for (const line of scanLines(markdown)) {
    if (line.fenced) continue;
    const match = RELEASE_HEADING.exec(line.text);
    if (match && DATED_HEADING_TAIL.test(match.groups.rest)) versions.push(match.groups.version);
  }
  return versions;
}

/**
 * Aggregate entries and unattributed text from the body of a section, starting after the
 * heading line at `start`. Shared by every section extractor — per-version and Unreleased
 * alike — because this is the subtle part and must exist exactly once.
 *
 * An entry is one top-level list item plus everything that belongs to it — continuation
 * lines, lazy continuations, later paragraphs of the same item, nested bullets at any depth,
 * and indented code samples. That aggregation is the point: a forbidden marker or a
 * work-log-length narrative parked below the first line of an item is the same violation as
 * one written on the item itself, and scoring each physical line separately would let either
 * walk straight through the gate.
 *
 * Item ownership follows the item's CONTENT indent rather than a fixed column. A bullet
 * indented to or past the open item's content column is nested inside it; anything less
 * starts a new top-level item. A fixed column gets both ends wrong — this repository's
 * two-space nested bullets would each become their own entry, and a legal one-to-three-space
 * top-level item would belong to nothing.
 *
 * Visible text inside the section that belongs to no item is reported rather than dropped;
 * silently ignoring a line the parser does not understand is how a scanner becomes a rubber
 * stamp. Blocks that render nothing — link reference definitions, HTML comments — are not
 * visible text and are skipped.
 */
function collectSectionBody(lines, start) {
  const entries = [];
  const unattributed = [];
  let current = null;
  let afterBlank = true;
  const close = () => {
    if (current) entries.push({ line: current.line, text: current.parts.join(" ").trim() });
    current = null;
  };

  for (let i = start + 1; i < lines.length; i += 1) {
    const { text, fenced, fenceIndent } = lines[i];
    if (!fenced && RELEASE_HEADING.test(text)) break;

    if (text.trim() === "") {
      afterBlank = true;
      continue;
    }

    if (fenced) {
      // A fence indented into the open item is part of it; one outside ends the list.
      if (current && fenceIndent >= current.contentIndent) current.parts.push(text.trim());
      else if (!current || fenceIndent < current.contentIndent) close();
      afterBlank = false;
      continue;
    }

    const bullet = BULLET.exec(text);
    if (bullet) {
      const indent = indentWidth(bullet.groups.indent);
      const nested = current !== null && indent >= current.contentIndent;
      if (nested) {
        if (bullet.groups.text !== undefined) current.parts.push(bullet.groups.text);
      } else {
        close();
        current = {
          line: i + 1,
          contentIndent: indent + bullet.groups.marker.length + indentWidth(bullet.groups.gap ?? " "),
          parts: bullet.groups.text === undefined ? [] : [bullet.groups.text],
        };
      }
      afterBlank = false;
      continue;
    }

    const indented = INDENTED.exec(text);
    // An unindented line with no blank line before it is a lazy continuation of the open
    // paragraph, which CommonMark keeps inside the item.
    if (current && (indented || !afterBlank)) {
      current.parts.push((indented ? indented.groups.text : text).trim());
      afterBlank = false;
      continue;
    }

    close();
    afterBlank = false;
    if (MARKDOWN_HEADING.test(text) || INVISIBLE_BLOCK.test(text)) continue;
    unattributed.push({ line: i + 1, text: text.trim() });
  }
  close();

  return { entries, unattributed };
}

/** Locate every non-fenced `## [...]` heading line whose match satisfies `predicate`. */
function locateHeadingLines(lines, predicate) {
  const headingLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].fenced) continue;
    const match = RELEASE_HEADING.exec(lines[i].text);
    if (match && predicate(match)) headingLines.push(i);
  }
  return headingLines;
}

/**
 * Locate the section for `version` and return its entries with 1-based source line numbers.
 *
 * `## [Unreleased]` is never a target: callers pass a concrete version, and a caller that
 * passes `"Unreleased"` gets `found: false` like any other absent section. Use
 * `extractUnreleasedSection` for that heading.
 */
export function extractReleaseSection(markdown, version) {
  const lines = scanLines(markdown);
  const headingLines = locateHeadingLines(lines, (match) => match.groups.version === version && version !== "Unreleased");

  if (headingLines.length === 0) return { found: false, version };

  const start = headingLines[0];
  const heading = lines[start].text;
  const dated = DATED_HEADING_TAIL.test(RELEASE_HEADING.exec(heading).groups.rest);
  const { entries, unattributed } = collectSectionBody(lines, start);

  return {
    found: true,
    version,
    heading,
    headingLine: start + 1,
    duplicateHeadingLines: headingLines.slice(1).map((i) => i + 1),
    dated,
    entries,
    unattributed,
  };
}

/**
 * Locate `## [Unreleased]` and return its entries the same way `extractReleaseSection` does
 * for a dated version, sharing the same body-parsing helper so the two can never diverge.
 * There is no `version` or `dated` field: Unreleased carries neither.
 */
export function extractUnreleasedSection(markdown) {
  const lines = scanLines(markdown);
  const headingLines = locateHeadingLines(lines, (match) => match.groups.version === "Unreleased");

  if (headingLines.length === 0) return { found: false };

  const start = headingLines[0];
  const heading = lines[start].text;
  const { entries, unattributed } = collectSectionBody(lines, start);

  return {
    found: true,
    heading,
    headingLine: start + 1,
    duplicateHeadingLines: headingLines.slice(1).map((i) => i + 1),
    entries,
    unattributed,
  };
}

/**
 * Findings shared by every section audit, dated or not: a repeated heading and visible text
 * that belongs to no entry are structural defects independent of release maturity.
 */
function duplicateHeadingFindings(duplicateHeadingLines, label) {
  return duplicateHeadingLines.map((line) => ({
    kind: "duplicate-section",
    line,
    detail: `"## [${label}]" appears more than once. Only the first is audited, so a second heading hides everything under it.`,
  }));
}

function unattributedTextFindings(unattributed) {
  return unattributed.map((line) => ({
    kind: "unattributed-text",
    line: line.line,
    detail: `visible text that belongs to no entry: ${JSON.stringify(line.text.slice(0, 60))}. The gate audits entries, so text outside one would ship unchecked.`,
  }));
}

/** An `empty-entry` finding for `entry`, or `null` when it has visible text. Shared for the same reason as above. */
function emptyEntryFinding(entry) {
  const rendered = renderedText(entry.text);
  if (entry.text.trim() !== "" && rendered.trim() !== "") return null;
  return {
    kind: "empty-entry",
    line: entry.line,
    detail: "a list item with no visible text. An entry that says nothing to the reader does not belong in a release section.",
  };
}

/** Audit one extracted section. Returns findings, most structural first. */
export function auditReleaseSection(section) {
  if (!section.found) {
    return [{
      kind: "missing-section",
      detail: `CHANGELOG.md has no "## [${section.version}]" section. A version bump and its release section are cut in the same change set.`,
    }];
  }

  const findings = [];

  findings.push(...duplicateHeadingFindings(section.duplicateHeadingLines, section.version));

  if (!section.dated) {
    findings.push({
      kind: "undated-section",
      line: section.headingLine,
      detail: `"## [${section.version}]" carries no "- YYYY-MM-DD" release date.`,
    });
  }

  findings.push(...unattributedTextFindings(section.unattributed));

  if (section.entries.length === 0) {
    findings.push({
      kind: "empty-section",
      line: section.headingLine,
      detail: `"## [${section.version}]" has no entries. A published version must describe what changed for the reader.`,
    });
  }

  for (const entry of section.entries) {
    const emptyFinding = emptyEntryFinding(entry);
    if (emptyFinding) {
      findings.push(emptyFinding);
      continue;
    }

    const rendered = renderedText(entry.text);
    for (const marker of FORBIDDEN_MARKERS) {
      const hit = marker.pattern.exec(entry.text) ?? marker.pattern.exec(rendered);
      if (!hit) continue;
      findings.push({
        kind: "internal-reference",
        marker: marker.id,
        line: entry.line,
        matched: hit[0].trim(),
        detail: marker.why,
      });
    }

    if (entry.text.length > RELEASE_ENTRY_MAX_CHARS) {
      findings.push({
        kind: "oversized-entry",
        line: entry.line,
        detail: `entry is ${entry.text.length} characters (ceiling ${RELEASE_ENTRY_MAX_CHARS}); state the observable contract delta and move the narrative out`,
      });
    }
  }

  return findings;
}

/** Audit `markdown` for `version`. `ok` is the gate verdict. */
export function auditChangelog(markdown, version) {
  const section = extractReleaseSection(markdown, version);
  const findings = auditReleaseSection(section);
  return {
    ok: findings.length === 0,
    version,
    entryCount: section.found ? section.entries.length : 0,
    findings,
  };
}

/**
 * Audit one extracted `## [Unreleased]` section for the checks that do not depend on
 * release maturity: a duplicated heading, visible text belonging to no entry, and an entry
 * with no visible text.
 *
 * Deliberately excluded, and this is the point of having a separate function rather than
 * calling `auditReleaseSection`: `undated-section` (Unreleased is never dated), `empty-section`
 * (Unreleased is legitimately empty right after a release cut), every `FORBIDDEN_MARKERS`
 * check, and `oversized-entry`. Those four assume a section has already been rewritten for a
 * reader with no access to this repository — a rule that applies only once a section is cut
 * into a dated release (AGENTS.md → CHANGELOG Content Rules). Applying them here would fail
 * on ordinary, legitimate work-log entries.
 *
 * A missing `## [Unreleased]` heading is not reported either, and that is a judgement call
 * rather than an oversight. The heading is kept present and empty between releases by
 * convention, so its absence is a real defect — but a `missing-section` finding is a NEW
 * rule, not one of the three structural checks above, and adding a rule that can fail a
 * release under cover of a refactor is how a gate acquires behavior nobody agreed to. If it
 * is wanted, it should be added deliberately and with its own test, not inherited here.
 */
export function auditUnreleasedSection(section) {
  if (!section.found) return [];

  const findings = [];
  findings.push(...duplicateHeadingFindings(section.duplicateHeadingLines, "Unreleased"));
  findings.push(...unattributedTextFindings(section.unattributed));

  for (const entry of section.entries) {
    const emptyFinding = emptyEntryFinding(entry);
    if (emptyFinding) findings.push(emptyFinding);
  }

  return findings;
}

/** Audit `markdown`'s `## [Unreleased]` section. `ok` is the gate verdict. */
export function auditUnreleased(markdown) {
  const section = extractUnreleasedSection(markdown);
  const findings = auditUnreleasedSection(section);
  return {
    ok: findings.length === 0,
    entryCount: section.found ? section.entries.length : 0,
    findings,
  };
}

/** Render an audit result as the text the author reads. */
export function renderReport(result, { file = "CHANGELOG.md" } = {}) {
  if (result.ok) {
    return `changelog gate: ${file} "## [${result.version}]" passed (${result.entryCount} entries).`;
  }

  const lines = [
    `changelog gate: ${file} "## [${result.version}]" FAILED with ${result.findings.length} finding(s).`,
    "",
    "CHANGELOG.md is an end-user document. Promoting Unreleased entries into a dated",
    "release section is a rewrite, not a move (AGENTS.md → CHANGELOG Content Rules).",
    "",
  ];

  for (const finding of result.findings) {
    const where = finding.line === undefined ? file : `${file}:${finding.line}`;
    const matched = finding.matched === undefined ? "" : ` (\`${finding.matched}\`)`;
    lines.push(`  ${where} — ${finding.kind}${matched}`);
    lines.push(`    ${finding.detail}`);
  }

  return lines.join("\n");
}

/** Render an Unreleased audit result as the text the author reads. Same style as `renderReport`. */
export function renderUnreleasedReport(result, { file = "CHANGELOG.md" } = {}) {
  if (result.ok) {
    return `changelog gate: ${file} "## [Unreleased]" passed (${result.entryCount} entries).`;
  }

  const lines = [
    `changelog gate: ${file} "## [Unreleased]" FAILED with ${result.findings.length} finding(s).`,
    "",
    "These are structural defects, not release-maturity ones: Unreleased may carry work-log",
    "detail freely, but a duplicated heading, text outside any entry, or an empty bullet is",
    "wrong regardless of maturity.",
    "",
  ];

  for (const finding of result.findings) {
    const where = finding.line === undefined ? file : `${file}:${finding.line}`;
    lines.push(`  ${where} — ${finding.kind}`);
    lines.push(`    ${finding.detail}`);
  }

  return lines.join("\n");
}
