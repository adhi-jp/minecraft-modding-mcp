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
  extractReleaseSection,
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

  const sample = auditChangelog(sectionFixture(["- ok\n\n```\n- src/main/java/Example.java\n```"]), "9.9.9");
  assert.deepEqual(sample.findings, []);

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

  const notACloser = auditChangelog(sectionFixture(["- ok\n\n```\nVerification: sample\n```not-a-close\n"]), "9.9.9");
  assert.deepEqual(notACloser.findings, [], "a run followed by text must not close the fence");
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
