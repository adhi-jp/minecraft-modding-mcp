import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  FORBIDDEN_MARKERS,
  RELEASE_ENTRY_MAX_CHARS,
  auditChangelog,
  auditReleaseSection,
  auditUnreleased,
  extractReleaseSection,
  extractUnreleasedSection,
  listReleaseVersions,
  renderReport
} from "../../scripts/changelog-release-gate.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Contract for the release CHANGELOG gate.
 *
 * `CHANGELOG.md` is an end-user document. Work-log detail is allowed to accumulate under
 * `## [Unreleased]` and MUST be rewritten when it is promoted into a dated release section
 * (AGENTS.md → CHANGELOG Content Rules). The gate enforces the mechanically decidable half
 * of that rule, so these tests pin three things:
 *
 *  1. It fires on the shapes a promoted work log actually has — repository paths, test
 *     files, fixtures, proof-of-work markers, outlier-length entries.
 *  2. It does NOT fire on `## [Unreleased]`, which is where that detail is permitted.
 *  3. It does not false-positive on the sections this repository has already cut properly:
 *     the live `CHANGELOG.md` section for the current package version must pass.
 */

const CHANGELOG_PATH = new URL("../../CHANGELOG.md", import.meta.url);
const PACKAGE_PATH = new URL("../../package.json", import.meta.url);

function sectionFixture(entries: string[], { heading = "## [9.9.9] - 2026-01-01" } = {}): string {
  return ["# Changelog", "", "## [Unreleased]", "", heading, "", "### Changed", "", ...entries, "", "## [9.9.8] - 2025-12-01", "", "- Older entry.", ""].join("\n");
}

test("the current package version's release section passes the gate", async () => {
  const markdown = await readFile(CHANGELOG_PATH, "utf8");
  const { version } = JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as { version: string };

  const result = auditChangelog(markdown, version);

  assert.equal(result.ok, true, renderReport(result));
  assert.ok(result.entryCount > 0, `"## [${version}]" reported no entries`);
});

test("every forbidden marker is detected in a released entry", () => {
  const probes: Record<string, string> = {
    "test-path": "- Pinned in `tests/stdio/era.test.ts` and the wire suite.",
    "source-path": "- `src/storage/sqlite.ts` imports `node:sqlite` at module load.",
    "script-path": "- The gate lives in `scripts/named-set-gate.mjs`.",
    "workflow-path": "- Reworked `.github/workflows/publish.yml` dist-tag resolution.",
    "build-output-path": "- The emitted `dist/index.d.ts` resolves Zod 4 types.",
    "test-file": "- Proven by stdio-supervisor-era-wire.test.ts end to end.",
    fixture: "- Bytes are frozen in Fixtures that cannot be re-recorded.",
    "proof-marker": "- Something changed. verification: the full green suite."
  };

  for (const marker of FORBIDDEN_MARKERS) {
    const entry = probes[marker.id];
    assert.ok(entry, `no probe entry for marker "${marker.id}"`);

    const findings = auditReleaseSection(extractReleaseSection(sectionFixture([entry]), "9.9.9"));

    assert.ok(
      findings.some((finding) => finding.kind === "internal-reference" && finding.marker === marker.id),
      `marker "${marker.id}" did not fire on: ${entry}`
    );
  }
});

test("a path-based marker fires even when preceded by '/' or '.', not only the allowed-punctuation set", () => {
  // Regression: the boundary used to be a fixed allowlist of preceding characters
  // ([\s`("'[) plus start-of-string) that omitted `/` and `.`, so the ordinary way
  // to write a relative or nested repository path in prose slipped through
  // undetected. A real word that merely ends in the marker text ("protests",
  // "contests") must still be spared.
  const probes: Array<{ marker: string; entry: string }> = [
    { marker: "test-path", entry: "- See ./tests/nested-jar-redirect-sample.json for the raw payload shape." },
    { marker: "test-path", entry: "- Root cause traced through packages/tests/foo-bar.ts coverage." },
    { marker: "source-path", entry: "- See ./src/repo-downloader.ts for the new redirect handling." },
    { marker: "script-path", entry: "- Config lives at ./scripts/changelog-release-gate.mjs now." }
  ];

  for (const { marker, entry } of probes) {
    const findings = auditReleaseSection(extractReleaseSection(sectionFixture([entry]), "9.9.9"));
    assert.ok(
      findings.some((finding) => finding.kind === "internal-reference" && finding.marker === marker),
      `marker "${marker}" did not fire on: ${entry}`
    );
  }

  const safe = auditReleaseSection(
    extractReleaseSection(sectionFixture(["- This protests the outcome loudly."]), "9.9.9")
  );
  assert.deepEqual(safe, [], "a word that merely ends in the marker text must not fire");
});

test("the length ceiling is exclusive: exactly the ceiling passes, one over fails", () => {
  const entry = (payload: number) => `- ${"a".repeat(payload)}`;

  const atCeiling = extractReleaseSection(sectionFixture([entry(RELEASE_ENTRY_MAX_CHARS)]), "9.9.9");
  assert.equal(atCeiling.entries[0].text.length, RELEASE_ENTRY_MAX_CHARS);
  assert.deepEqual(auditReleaseSection(atCeiling), []);

  const overCeiling = extractReleaseSection(sectionFixture([entry(RELEASE_ENTRY_MAX_CHARS + 1)]), "9.9.9");
  assert.equal(overCeiling.entries[0].text.length, RELEASE_ENTRY_MAX_CHARS + 1);
  assert.ok(auditReleaseSection(overCeiling).some((finding) => finding.kind === "oversized-entry"));
});

test("an entry owns its continuation lines and nested bullets", () => {
  // The bypass this closes: park the violation one line below the bullet and the gate used
  // to score each physical line separately, so neither the marker nor the length was seen.
  const continuation = auditChangelog(
    sectionFixture(["- Something changed.\n  Verification: tests/foo.test.ts and the full suite."]),
    "9.9.9"
  );
  assert.ok(continuation.findings.some((finding) => finding.marker === "proof-marker"));
  assert.ok(continuation.findings.some((finding) => finding.marker === "test-path"));

  const spread = auditChangelog(
    sectionFixture([`- Lead.\n  - ${"y".repeat(800)}\n  - ${"z".repeat(800)}`]),
    "9.9.9"
  );
  assert.ok(spread.findings.some((finding) => finding.kind === "oversized-entry"));

  const section = extractReleaseSection(sectionFixture(["- One.\n  Two.", "- Three."]), "9.9.9");
  assert.deepEqual(section.entries.map((entry) => entry.text), ["One. Two.", "Three."]);
});

test("no list marker and no blank line lets a violation escape its entry", () => {
  // `-` is this repository's convention, so the first implementation only looked for `-`
  // and closed an entry at the first blank line. Both are escapes: the reader sees this
  // text either way.
  const escapes = [
    "- Safe.\n* Verification: tests/x.test.ts",
    "- Safe.\n+ Verification: tests/x.test.ts",
    "- Safe.\n1. Verification: tests/x.test.ts",
    "- Safe.\n\n  Verification: tests/x.test.ts",
    "- Safe.\n-\n  Verification: tests/x.test.ts",
    "- Safe.\n\tVerification: tests/x.test.ts",
    "- Safe.\n    - Root cause in src/foo.ts"
  ];

  for (const entry of escapes) {
    assert.equal(auditChangelog(sectionFixture([entry]), "9.9.9").ok, false, `escaped the gate: ${JSON.stringify(entry)}`);
  }
});

test("an item is nested by the open item's content column, not by a fixed one", () => {
  // Both ends matter. This repository writes nested bullets at two spaces, so a fixed
  // top-level column would split one entry into several and undo the aggregation; a legal
  // one-to-three-space top-level item would meanwhile belong to nothing.
  const nested = extractReleaseSection(sectionFixture(["- Lead sentence.\n  - a nested detail\n  - another"]), "9.9.9");
  assert.deepEqual(nested.entries.map((entry) => entry.text), ["Lead sentence. a nested detail another"]);

  for (const entry of [" * Safe user-facing change.", "   - Safe user-facing change."]) {
    assert.deepEqual(auditChangelog(sectionFixture([entry]), "9.9.9").findings, [], `rejected a legal top-level item: ${entry}`);
  }
});

test("an unclosed fence inside an item cannot swallow the next release section", () => {
  // CommonMark runs an unclosed fence to end of document, which would hide every later
  // section and leave the gate reporting a clean file because it can no longer see them.
  const markdown = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [9.9.9] - 2026-01-01",
    "",
    "- Safe first entry.",
    "",
    "  ~~~",
    "## [9.9.9] - 2026-01-02",
    "",
    "- Verification: tests/x.test.ts",
    ""
  ].join("\n");

  assert.deepEqual(listReleaseVersions(markdown), ["9.9.9", "9.9.9"]);
  assert.ok(auditChangelog(markdown, "9.9.9").findings.some((finding) => finding.kind === "duplicate-section"));
});

test("a list item with no visible text is not an entry", () => {
  for (const entry of ["-", "*", "1.", "- <!-- internal note -->"]) {
    assert.ok(
      auditChangelog(sectionFixture([entry]), "9.9.9").findings.some((finding) => finding.kind === "empty-entry"),
      `accepted an empty entry: ${JSON.stringify(entry)}`
    );
  }
});

test("markup that renders away cannot split a marker", () => {
  // Each of these renders as the forbidden token but does not contain it as source bytes.
  const split = [
    "- Verifi`cation:` the suite ran.",
    "- Verification\\: the suite ran.",
    "- See tests&#47;helper.json for details.",
    "- Verifi<!--x-->cation: the suite ran.",
    "- te`sts/`helper.json is where it lives."
  ];

  for (const entry of split) {
    assert.equal(auditChangelog(sectionFixture([entry]), "9.9.9").ok, false, `split marker escaped: ${entry}`);
  }
});

test("blocks that render nothing are not unattributed text", () => {
  for (const entry of ["- ok\n\n[mode]: https://example.com/spec", "- ok\n\n<!-- an internal note -->"]) {
    assert.deepEqual(auditChangelog(sectionFixture([entry]), "9.9.9").findings, [], `reported an invisible block: ${entry}`);
  }

  // A lazy continuation is still part of the item, so its violation is the item's.
  assert.equal(auditChangelog(sectionFixture(["- Safe.\nVerification: tests/x.test.ts"]), "9.9.9").ok, false);
});

test("markers match regardless of case", () => {
  const variants = [
    "- Frozen in Fixtures that cannot be re-recorded.",
    "- Bytes come from the Goldens.",
    "- Something changed. verification: the full suite.",
    "- Details in TESTS/stdio/era.test.ts."
  ];

  for (const entry of variants) {
    assert.equal(auditChangelog(sectionFixture([entry]), "9.9.9").ok, false, `case escape: ${entry}`);
  }
});

test("visible text belonging to no entry is reported, not dropped", () => {
  const result = auditChangelog(sectionFixture(["- ok\n\nThis paragraph belongs to no entry."]), "9.9.9");

  assert.ok(result.findings.some((finding) => finding.kind === "unattributed-text"));
  assert.deepEqual(auditChangelog(sectionFixture(["- ok\n\n### Fixed\n\n- also ok"]), "9.9.9").findings, []);
});

test("fenced code blocks are sample content, not structure", () => {
  // A fence must neither end the section early nor contribute false positives.
  const hidden = auditChangelog(
    sectionFixture(["- ok\n\n```\n## [0.0.0]\n```\n\n- Root cause in src/foo.ts."]),
    "9.9.9"
  );
  assert.ok(hidden.findings.some((finding) => finding.marker === "source-path"));

  // A column-0 fence belongs to no entry, so its lines are reported as text outside one — but
  // they are never audited as prose, which is what keeps a Java path in a code sample from
  // reading as an `internal-reference`.
  const sample = auditChangelog(sectionFixture(["- ok\n\n```\n- src/main/java/Example.java\n```"]), "9.9.9");
  assert.deepEqual(
    sample.findings.map((finding) => finding.kind),
    ["unattributed-text"]
  );

  // Indented into the item, the same sample is part of that item and contributes nothing.
  assert.deepEqual(auditChangelog(sectionFixture(["- ok\n\n  ```\n  - Example.java\n  ```"]), "9.9.9").findings, []);

  assert.deepEqual(listReleaseVersions("## [1.0.0] - 2020-01-01\n\n```\n## [0.0.0] - 2019-01-01\n```\n"), ["1.0.0"]);
});

test("a fence opens and closes only under CommonMark's conditions", () => {
  // Both directions matter. Accepting a four-space run or a backtick-bearing info string as
  // an opener would hide everything after it; accepting a run followed by text as a closer
  // would end the block early and audit sample content as prose.
  const notOpeners = [
    "- ok\n\n    ```\n    - Verification: tests/x.test.ts\n    ```",
    "- ok\n\n```bad`info\n- Verification: tests/x.test.ts\n```"
  ];
  for (const entry of notOpeners) {
    assert.equal(auditChangelog(sectionFixture([entry]), "9.9.9").ok, false, `treated as a fence: ${entry}`);
  }

  // A run followed by text is not a closer. Structure proves it: a release heading written
  // after the false closer is still sample content, not a second section.
  assert.deepEqual(
    listReleaseVersions("## [1.0.0] - 2020-01-01\n\n```\nsample\n```not-a-close\n## [0.0.0] - 2019-01-01\n```\n"),
    ["1.0.0"],
    "a run followed by text must not close the fence"
  );

  // Lines inside the block are reported as text belonging to no entry rather than dropped,
  // and still never audited as prose: the marker checks do not run against a code sample.
  const notACloser = auditChangelog(sectionFixture(["- ok\n\n```\nVerification: sample\n```not-a-close\n"]), "9.9.9");
  assert.ok(notACloser.findings.length > 0, "fenced text outside every entry must be reported");
  assert.ok(
    notACloser.findings.every((finding) => finding.kind === "unattributed-text"),
    "a code sample must never be audited as prose"
  );
});

test("a fenced block that belongs to no entry is reported, not dropped", () => {
  // A fence opened at column 0 sits outside the item above it, so nothing in the section owned
  // its lines and they were discarded: a work-log dump parked in a top-level code block shipped
  // green. Fenced text outside every entry is visible text like any other.
  const markdown = sectionFixture([
    [
      "- The artifact index recovers from a corrupt database instead of failing the call.",
      "",
      "```",
      "Verification: full suite green.",
      "Pinned by tests/contracts/foo.test.ts and scripts/check-changelog.mjs",
      "```"
    ].join("\n")
  ]);

  const result = auditChangelog(markdown, "9.9.9");

  assert.equal(result.ok, false, "a fenced block outside every entry must fail the gate");
  for (const quoted of [/Verification: full suite green\./, /Pinned by tests\/contracts\/foo\.test\.ts/]) {
    assert.ok(
      result.findings.some((finding) => finding.kind === "unattributed-text" && quoted.test(finding.detail)),
      `no finding named the fenced text matching ${quoted}`
    );
  }

  // The correctly indented form is untouched: a fence inside the item is part of that item.
  assert.deepEqual(auditChangelog(sectionFixture(["- ok\n\n  ```\n  sample output\n  ```"]), "9.9.9").findings, []);
});

test("an unterminated fence cannot hide the release sections that follow it", () => {
  // A fence with no closer runs to end of document under CommonMark, so one stray column-0 run
  // swallowed every later heading and the gate reported a clean file because it could no longer
  // see them. Recovery is bounded to that malformed case: a fence that IS closed keeps its
  // sample content, a sample release heading included.
  const markdown = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [9.9.9] - 2026-01-01",
    "",
    "- The artifact index recovers from a corrupt database instead of failing the call.",
    "",
    "```",
    "",
    "## [9.8.0] - 2025-12-01",
    "",
    "- Verification: tests/loader.test.ts green.",
    ""
  ].join("\n");

  assert.deepEqual(listReleaseVersions(markdown), ["9.9.9", "9.8.0"]);

  const result = auditChangelog(markdown, "9.8.0");
  assert.ok(
    !result.findings.some((finding) => finding.kind === "missing-section"),
    "the swallowed section must be visible to the audit"
  );
  assert.ok(result.findings.some((finding) => finding.marker === "proof-marker"));
  assert.ok(result.findings.some((finding) => finding.marker === "test-path"));

  assert.deepEqual(
    listReleaseVersions("## [1.0.0] - 2020-01-01\n\n```\n## [0.0.0] - 2019-01-01\n```\n"),
    ["1.0.0"],
    "a terminated fence still holds its sample heading as content"
  );
});

test("CRLF input is audited, and the extractor and version listing agree on it", () => {
  const crlf = sectionFixture(["- Verification: tests/foo.test.ts"]).replace(/\n/g, "\r\n");

  assert.equal(extractReleaseSection(crlf, "9.9.9").found, true);
  assert.deepEqual(listReleaseVersions(crlf), ["9.9.9", "9.9.8"]);
  assert.equal(auditChangelog(crlf, "9.9.9").ok, false);
});

test("a repeated version heading is a structural failure, not a silently ignored one", () => {
  const result = auditChangelog(
    sectionFixture(["- ok\n\n## [9.9.9] - 2026-01-02\n\n- Verification: tests/x.test.ts"]),
    "9.9.9"
  );

  assert.ok(result.findings.some((finding) => finding.kind === "duplicate-section"));
});

test("work-log detail under Unreleased is not audited", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Root cause in `src/storage/sqlite.ts`. Verification: `tests/storage/sqlite.test.ts`.",
    "",
    "## [9.9.9] - 2026-01-01",
    "",
    "- The artifact index recovers from a corrupt database instead of failing the call.",
    ""
  ].join("\n");

  assert.equal(auditChangelog(markdown, "9.9.9").ok, true);
  assert.equal(extractReleaseSection(markdown, "Unreleased").found, false);
});

test("user-facing paths are allowed in a released entry", () => {
  const entries = [
    "- `docs/tool-reference.md` documents the mapping rule the schema description cannot state.",
    "- `README.md` records the raised Node.js floor.",
    "- `package.json` `files` now names the three intended documents explicitly."
  ];

  assert.deepEqual(auditReleaseSection(extractReleaseSection(sectionFixture(entries), "9.9.9")), []);
});

test("a missing, undated, or empty release section fails", () => {
  const missing = auditChangelog(sectionFixture(["- Something."]), "7.7.7");
  assert.equal(missing.ok, false);
  assert.equal(missing.findings[0].kind, "missing-section");

  const undated = auditChangelog(sectionFixture(["- Something."], { heading: "## [9.9.9]" }), "9.9.9");
  assert.ok(undated.findings.some((finding) => finding.kind === "undated-section"));

  const empty = auditChangelog(sectionFixture([]), "9.9.9");
  assert.ok(empty.findings.some((finding) => finding.kind === "empty-section"));
});

test("the failure report names the file, the line, and the rule", () => {
  const markdown = sectionFixture(["- Reworked the reader. Verification: the full green suite."]);
  const result = auditChangelog(markdown, "9.9.9");
  const report = renderReport(result);

  assert.match(report, /FAILED with 1 finding/);
  assert.match(report, /CHANGELOG\.md:9 — internal-reference/);
  assert.match(report, /rewrite, not a move/);
});

test("the CLI rejects a malformed invocation instead of falling back to the default mode", async () => {
  const run = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("node", ["scripts/check-changelog.mjs", ...args], { cwd: REPO_ROOT });
      return { code: 0, output: stdout };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  assert.equal((await run([])).code, 0);
  assert.equal((await run(["--version", "6.3.0"])).code, 0);

  const usageErrors = [
    ["--version"],
    ["--version="],
    ["--all", "--version", "6.3.0"],
    ["--bogus"],
    ["--version", "--all"],
    ["--version", "--bogus"],
    ["--version", "6.3.0", "--version", "7.0.0-rc.0"],
    ["--all", "--all"]
  ];

  for (const args of usageErrors) {
    const result = await run(args);
    assert.equal(result.code, 2, `${args.join(" ")} should be a usage error, got ${result.code}`);
    // Captured through a pipe on purpose: process.exit() would drop these bytes.
    assert.match(result.output, /Usage:/, `${args.join(" ")} lost its diagnostics`);
  }

  const missing = await run(["--version", "99.99.99"]);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /missing-section/);

  const all = await run(["--all"]);
  assert.equal(all.code, 1, "--all must fail while the already-tagged 4.1.0 section carries internal references");
});

test("both workflows run the gate, and the gate workflow watches the files that can break a release section", async () => {
  const read = async (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

  const publish = await read(".github/workflows/publish.yml");
  assert.match(publish, /run: node scripts\/check-changelog\.mjs/);
  assert.ok(
    publish.indexOf("node scripts/check-changelog.mjs") < publish.indexOf("npm publish"),
    "the gate must run before publish"
  );

  const gate = await read(".github/workflows/changelog-gate.yml");
  assert.match(gate, /run: node scripts\/check-changelog\.mjs/);
  for (const watched of ["CHANGELOG.md", "package.json", "scripts/changelog-release-gate.mjs", "scripts/check-changelog.mjs"]) {
    assert.ok(gate.includes(`'${watched}'`), `changelog-gate.yml must trigger on ${watched}`);
  }

  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["check:changelog"], "node scripts/check-changelog.mjs");

  // The lightweight workflow only runs the gate against the live CHANGELOG, so gutting the
  // policy module would leave it green. These contract tests are what catch that, and they
  // only run if CI itself triggers on the gate's own sources.
  const ci = await read(".github/workflows/ci.yml");
  for (const watched of ["scripts/**", ".github/workflows/**"]) {
    assert.ok(ci.includes(`'${watched}'`), `ci.yml must trigger on ${watched} so these tests stay reachable`);
  }
});

/**
 * Contract for the Unreleased structural audit.
 *
 * `## [Unreleased]` is exempt from the release-maturity content rules (forbidden markers,
 * the length ceiling, undated-section, empty-section) — see the "work-log detail under
 * Unreleased is not audited" test above, which this audit must not disturb. But it is not
 * exempt from structural defects that are independent of maturity: a duplicated heading, text
 * that belongs to no entry, and an entry with no visible text break the document the same way
 * regardless of which section they sit under.
 */

function unreleasedFixture(body: string): string {
  return ["# Changelog", "", "## [Unreleased]", "", body, "", "## [9.9.9] - 2026-01-01", "", "- Older entry.", ""].join(
    "\n"
  );
}

test("the Unreleased audit fires on a duplicated '## [Unreleased]' heading", () => {
  const markdown = ["# Changelog", "", "## [Unreleased]", "", "- ok", "", "## [Unreleased]", "", "- also ok", ""].join(
    "\n"
  );

  const result = auditUnreleased(markdown);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === "duplicate-section"));
});

test("the Unreleased audit fires on visible text that belongs to no entry", () => {
  const result = auditUnreleased(unreleasedFixture("This paragraph belongs to no entry."));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === "unattributed-text"));
});

test("the Unreleased audit fires on an empty bullet", () => {
  const result = auditUnreleased(unreleasedFixture("-"));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === "empty-entry"));
});

test("the Unreleased audit does not fire on a long, internal-reference-laden entry", () => {
  // Regression guard: this is exactly the shape that would fail the release-maturity checks
  // (oversized-entry, internal-reference) if they were mistakenly applied to Unreleased.
  const longEntry = `- Root cause in \`src/storage/sqlite.ts\`. Verification: \`tests/storage/sqlite.test.ts\`. ${"a".repeat(
    RELEASE_ENTRY_MAX_CHARS + 200
  )}`;
  assert.ok(longEntry.length > RELEASE_ENTRY_MAX_CHARS);

  const result = auditUnreleased(unreleasedFixture(longEntry));
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test("the repository's real CHANGELOG.md Unreleased section passes the new audit", async () => {
  const markdown = await readFile(CHANGELOG_PATH, "utf8");

  const result = auditUnreleased(markdown);

  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test("check-changelog.mjs audits Unreleased in every invocation mode, not only one", async () => {
  const run = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("node", ["scripts/check-changelog.mjs", ...args], { cwd: REPO_ROOT });
      return { code: 0, output: stdout };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  for (const args of [[], ["--version", "6.3.0"], ["--all"]]) {
    const result = await run(args);
    assert.match(
      result.output,
      /"## \[Unreleased\]"/,
      `${args.join(" ") || "(default)"} did not report on the Unreleased audit`
    );
  }
});

test("extractUnreleasedSection never targets a dated version, only the literal heading", () => {
  const markdown = unreleasedFixture("- ok");
  assert.equal(extractUnreleasedSection(markdown).found, true);
  assert.equal(extractReleaseSection(markdown, "Unreleased").found, false);
});

/**
 * Run the REAL runner script against a synthetic CHANGELOG.
 *
 * The runner resolves its CHANGELOG and package.json from its own location, so the only way
 * to feed it a fixture is to stand up a throwaway repository around a copy of it. Copying —
 * rather than re-implementing the wiring in the test — is what makes the exit status below
 * evidence about the shipped script.
 */
async function runGateOnFixture(changelog: string, args: string[]): Promise<{ code: number; output: string }> {
  const { copyFile, mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "changelog-gate-fixture-"));
  await mkdir(join(root, "scripts"));
  for (const script of ["check-changelog.mjs", "changelog-release-gate.mjs"]) {
    await copyFile(join(REPO_ROOT, "scripts", script), join(root, "scripts", script));
  }
  await writeFile(join(root, "CHANGELOG.md"), changelog);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "changelog-gate-fixture", version: "9.9.9" }));

  const script = join(root, "scripts", "check-changelog.mjs");
  try {
    const { stdout, stderr } = await execFileAsync("node", [script, ...args]);
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/**
 * The test above proves the Unreleased audit is REPORTED in every mode. Reporting is not
 * gating: delete the one line in the runner that folds the Unreleased verdict into the
 * failure state and that test stays green while every mode goes non-blocking — the whole
 * feature silently bypassed. This one pins the exit status instead, so that deletion fails.
 */
test("check-changelog.mjs exits non-zero when the only defect is in Unreleased", async () => {
  const dated = ["## [9.9.9] - 2026-01-01", "", "- Fixed a thing users can see.", ""];
  const clean = ["# Changelog", "", "## [Unreleased]", "", "- A fine entry.", "", ...dated].join("\n");
  const defective = ["# Changelog", "", "## [Unreleased]", "", "-", "", "- A fine entry.", "", ...dated].join("\n");

  // Control: the same fixture minus the empty bullet must PASS. Without it a non-zero exit
  // below would prove only that the fixture was broken somewhere, not that Unreleased gates.
  const control = await runGateOnFixture(clean, []);
  assert.equal(control.code, 0, `the control fixture must pass:\n${control.output}`);

  for (const args of [[], ["--version", "9.9.9"], ["--all"]]) {
    const result = await runGateOnFixture(defective, args);
    assert.equal(
      result.code,
      1,
      `${args.join(" ") || "(default)"} must FAIL on an Unreleased-only defect, not merely report it:\n${result.output}`
    );
    assert.match(result.output, /empty-entry/, "the failure must be the Unreleased finding, not something else");
  }
});

/**
 * The parser reads one shared `scanLines`, so a fenced sample of a release heading must stay
 * sample content for BOTH audits. Pinned because the alternative — a sample line read as a
 * real heading — reports a `duplicate-section` the author cannot act on, and because the
 * fence rule carries a known false positive on the MALFORMED variant (content at column 0
 * under indented markers; see `scanLines`). This is the correct, common form, and it is the
 * one that must never drift.
 */
test("a correctly indented fenced sample of a release heading stays sample content in both audits", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Documented the heading shape a release cut produces:",
    "",
    "  ```md",
    "  ## [Unreleased]",
    "  ## [9.9.9] - 2026-01-01",
    "  ```",
    "",
    "## [9.9.9] - 2026-01-01",
    "",
    "- Fixed a thing users can see.",
    ""
  ].join("\n");

  assert.deepEqual(auditUnreleased(markdown).findings, []);
  assert.deepEqual(auditChangelog(markdown, "9.9.9").findings, []);
  // The fenced headings must not register as sections either, or `--all` would audit one.
  assert.deepEqual(listReleaseVersions(markdown), ["9.9.9"]);
});
