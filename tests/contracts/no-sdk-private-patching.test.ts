import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Contract: the "no SDK-private patching" check is an ordinary test, not a
// script nobody runs. It scans src/ for three shapes of coupling to SDK
// internals (patching through a type cast, writing SDK-private members, and
// deep-importing package internals) and must be provably self-falsifying:
// synthetic offenders are asserted to be caught with the expected rule and
// member, and synthetic benign look-alikes are asserted to be ignored.
//
// This contract SUPPLEMENTS tests/contracts/no-sdk-private-request-handler-access.ts
// (a repo-wide literal scan); it does not replace it.
//
// The private-map identifier below is assembled by concatenation so that the
// literal never appears on any line of this file — otherwise the literal
// scanner would flag this scanner's own fixtures.
const PRIVATE_MAP = "_request" + "Handlers";

const SDK_IMPORT = 'import type { McpServer } from "@modelcontextprotocol/server";';

type Finding = {
  rule: string;
  file: string;
  line: number;
  column: number;
  member?: string;
  specifier?: string;
  excerpt: string;
};

type ScannerCore = {
  scanSourceText: (input: { filePath: string; sourceText: string }) => Finding[];
  scanSourceTree: (input: { repoRoot: string; sourceRoot: string }) => {
    files: string[];
    findings: Finding[];
  };
  formatFindings: (findings: Finding[], options?: { limit?: number }) => string;
};

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let corePromise: Promise<ScannerCore> | undefined;

function loadCore(): Promise<ScannerCore> {
  corePromise ??= import("../../scripts/premigration/no-sdk-private-patching-core.mjs") as Promise<ScannerCore>;
  return corePromise;
}

/** Collapses a finding to the assertable identity: which rule, on what. */
function fingerprint(finding: Finding): string {
  return `${finding.rule}|${finding.member ?? finding.specifier ?? ""}`;
}

function fingerprints(findings: Finding[]): string[] {
  return findings.map(fingerprint).sort();
}

const RULE_A = "A:type-cast-member-assignment";
const RULE_B = "B:sdk-private-member-write";
const RULE_C = "C:sdk-internal-deep-import";

type Case = { name: string; source: string; expected: string[] };

const POSITIVE_CASES: Case[] = [
  {
    name: "dot write to the SDK-private validation hook",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, fn: unknown): void {",
      "  server.validateToolInput = fn;",
      "}"
    ].join("\n"),
    expected: [`${RULE_B}|validateToolInput`]
  },
  {
    name: "string-literal bracket write to the private handler map",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, next: unknown): void {",
      `  server["${PRIVATE_MAP}"] = next;`,
      "}"
    ].join("\n"),
    expected: [`${RULE_B}|${PRIVATE_MAP}`]
  },
  {
    name: "no-substitution template bracket write to the private handler map",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, next: unknown): void {",
      `  server[\`${PRIVATE_MAP}\`] = next;`,
      "}"
    ].join("\n"),
    expected: [`${RULE_B}|${PRIVATE_MAP}`]
  },
  {
    name: "Object.assign patch onto an `as any` cast target",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, fn: unknown): void {",
      "  Object.assign(server as any, { validateToolInput: fn });",
      "}"
    ].join("\n"),
    expected: [`${RULE_A}|validateToolInput`, `${RULE_B}|validateToolInput`]
  },
  {
    name: "Object.assign patch with a computed private key",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, next: unknown): void {",
      `  Object.assign(server, { ["${PRIVATE_MAP}"]: next });`,
      "}"
    ].join("\n"),
    expected: [`${RULE_B}|${PRIVATE_MAP}`]
  },
  {
    name: "Object.assign patch with a shorthand private property",
    source: [
      SDK_IMPORT,
      "export function patch(server: McpServer, validateToolInput: unknown): void {",
      "  Object.assign(server, { validateToolInput });",
      "}"
    ].join("\n"),
    expected: [`${RULE_B}|validateToolInput`]
  },
  {
    name: "bracket write through an `as unknown as {...}` cast",
    source: [
      "export function patch(server: unknown, next: unknown): void {",
      `  (server as unknown as { ${PRIVATE_MAP}: unknown })["${PRIVATE_MAP}"] = next;`,
      "}"
    ].join("\n"),
    expected: [`${RULE_A}|${PRIVATE_MAP}`]
  },
  {
    name: "compound write through an `as any` cast",
    source: [
      "export function bump(server: unknown): void {",
      "  (server as any)._patchCount += 1;",
      "}"
    ].join("\n"),
    expected: [`${RULE_A}|_patchCount`]
  },
  {
    name: "cast-mechanism write to a public member trips rule A only",
    source: [
      SDK_IMPORT,
      "export function configure(server: McpServer, value: number): void {",
      "  (server as any).timeoutMs = value;",
      "}"
    ].join("\n"),
    // Rule A flags the cast mechanism itself; rule B stays silent because
    // `timeoutMs` is not part of the private surface.
    expected: [`${RULE_A}|timeoutMs`]
  },
  {
    name: "deep import of SDK package internals under /dist/",
    source: [
      'import { internals } from "@modelcontextprotocol/server/dist/internal.js";',
      "export const value = internals;"
    ].join("\n"),
    expected: [`${RULE_C}|@modelcontextprotocol/server/dist/internal.js`]
  },
  {
    name: "require of a node_modules path",
    source: [
      "const mod = require(\"../../node_modules/@modelcontextprotocol/server/lowlevel.js\");",
      "export const value = mod;"
    ].join("\n"),
    expected: [`${RULE_C}|../../node_modules/@modelcontextprotocol/server/lowlevel.js`]
  }
];

const NEGATIVE_CASES: Case[] = [
  {
    name: "bracket READ of the private handler map is not a write",
    source: [
      SDK_IMPORT,
      "export function read(server: McpServer, name: string): unknown {",
      `  return server["${PRIVATE_MAP}"].get(name);`,
      "}"
    ].join("\n"),
    expected: []
  },
  {
    name: "CALL through an `as any` cast is not a write",
    source: [
      SDK_IMPORT,
      "export function call(server: McpServer, args: unknown): unknown {",
      "  return (server as any).validateToolInput(args);",
      "}"
    ].join("\n"),
    expected: []
  },
  {
    name: "comparison against a private member is not a write",
    source: [
      SDK_IMPORT,
      "export function has(server: McpServer): boolean {",
      "  return server.validateToolInput === undefined;",
      "}"
    ].join("\n"),
    expected: []
  },
  {
    name: "public SDK package and subpath imports are allowed",
    source: [
      'import { McpServer } from "@modelcontextprotocol/server";',
      'import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";',
      "export const pair = [McpServer, StdioServerTransport];"
    ].join("\n"),
    expected: []
  },
  {
    name: "public SDK subpath dynamic import is allowed",
    source: [
      "export async function load(): Promise<unknown> {",
      '  return import("@modelcontextprotocol/server/stdio");',
      "}"
    ].join("\n"),
    expected: []
  },
  {
    name: "ordinary Object.assign onto a plain object is allowed",
    source: [
      SDK_IMPORT,
      "declare function buildSuggestedCall(input: unknown): Record<string, unknown>;",
      "export function decorate(details: Record<string, unknown>, input: unknown): void {",
      "  Object.assign(details, buildSuggestedCall(input));",
      "  Object.assign(details, { suggestedCall: buildSuggestedCall(input) });",
      "}"
    ].join("\n"),
    expected: []
  },
  {
    name: "reading a private member through a cast is not a write",
    source: [
      SDK_IMPORT,
      "export function peek(server: McpServer): unknown {",
      "  return (server as any).validateToolInput;",
      "}"
    ].join("\n"),
    expected: []
  }
];

test("synthetic SDK-private patching offenders are each caught with the expected rule and member", async () => {
  const { scanSourceText } = await loadCore();

  for (const testCase of POSITIVE_CASES) {
    const findings = scanSourceText({
      filePath: "src/synthetic-positive.ts",
      sourceText: testCase.source
    });

    assert.deepEqual(
      fingerprints(findings),
      [...testCase.expected].sort(),
      `positive case "${testCase.name}" must produce exactly the expected findings.\n` +
        `source:\n${testCase.source}\nfindings: ${JSON.stringify(findings, null, 2)}`
    );

    for (const finding of findings) {
      assert.equal(finding.file, "src/synthetic-positive.ts");
      assert.ok(finding.line >= 1, "every finding carries a 1-based line");
      assert.ok(finding.column >= 1, "every finding carries a 1-based column");
      assert.ok(
        typeof finding.excerpt === "string" && finding.excerpt.length > 0 && finding.excerpt.length <= 200,
        "every finding carries a bounded, non-empty excerpt"
      );
    }
  }
});

test("benign look-alikes (reads, calls, public imports, ordinary Object.assign) are not flagged", async () => {
  const { scanSourceText } = await loadCore();

  for (const testCase of NEGATIVE_CASES) {
    const findings = scanSourceText({
      filePath: "src/synthetic-negative.ts",
      sourceText: testCase.source
    });

    assert.deepEqual(
      fingerprints(findings),
      [...testCase.expected].sort(),
      `negative case "${testCase.name}" must produce exactly the expected findings.\n` +
        `source:\n${testCase.source}\nfindings: ${JSON.stringify(findings, null, 2)}`
    );
  }
});

test("findings are ordered deterministically and formatting honors its limit", async () => {
  const { scanSourceText, formatFindings } = await loadCore();

  const source = [
    'import type { McpServer } from "@modelcontextprotocol/server";',
    'import { internals } from "@modelcontextprotocol/server/dist/internal.js";',
    "export function patch(server: McpServer, fn: unknown, next: unknown): void {",
    "  Object.assign(server as any, { validateToolInput: fn });",
    `  server["${PRIVATE_MAP}"] = next;`,
    "}",
    "export const value = internals;"
  ].join("\n");

  const findings = scanSourceText({ filePath: "src/synthetic-many.ts", sourceText: source });

  assert.deepEqual(fingerprints(findings), [
    `${RULE_A}|validateToolInput`,
    `${RULE_B}|${PRIVATE_MAP}`,
    `${RULE_B}|validateToolInput`,
    `${RULE_C}|@modelcontextprotocol/server/dist/internal.js`
  ]);

  // Sort order: file, then line, then column, then rule.
  const keys = findings.map((finding) => [finding.file, finding.line, finding.column, finding.rule] as const);
  const sorted = [...keys].sort(
    (left, right) =>
      left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2] || left[3].localeCompare(right[3])
  );
  assert.deepEqual(keys, sorted, "scanSourceText must return findings in a stable sorted order");

  const formatted = formatFindings(findings, { limit: 2 });
  // Header lines start with exactly two spaces then the bracketed rule id;
  // excerpt lines are indented further (and may themselves contain brackets).
  const headerLines = formatted.split("\n").filter((line) => /^ {2}\[/.test(line));
  assert.equal(headerLines.length, 2, "formatFindings must emit only `limit` findings");
  assert.match(formatted, /2 more/, "formatFindings must report how many findings it withheld");
  assert.ok(formatted.includes(RULE_A), "formatted output names the rule that fired");
});

test("the real src/ tree scan has a non-vacuous inventory and zero findings", async () => {
  const { scanSourceTree, formatFindings } = await loadCore();

  const { files, findings } = scanSourceTree({
    repoRoot: REPO_ROOT,
    sourceRoot: join(REPO_ROOT, "src")
  });

  // Non-vacuity floor: a misrooted or empty scan would make the zero-findings
  // assertion meaningless.
  assert.ok(files.length >= 50, `the scan must cover >= 50 source files, saw ${files.length}`);
  assert.ok(files.includes("src/index.ts"), "the scan must include src/index.ts");
  assert.ok(files.includes("src/stdio-supervisor.ts"), "the scan must include src/stdio-supervisor.ts");

  assert.equal(
    findings.length,
    0,
    `src/ must not patch SDK internals. Findings:\n${formatFindings(findings, { limit: 25 })}`
  );
});
