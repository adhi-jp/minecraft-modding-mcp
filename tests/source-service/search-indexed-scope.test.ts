import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedSearchFixture,
  type SearchFixture
} from "../helpers/source-service-search-fixtures.ts";

// Indexed text/path search reads one bounded candidate window (500 rows for
// exact/prefix, 1000 for contains at maxSearchHits=200). The scope fixture puts
// more out-of-scope candidates than either window ahead of the in-scope files,
// so an in-scope hit is only reachable when the scope narrows the window itself.
const OUT_OF_SCOPE_COUNT = 1_040;
const SCOPED_PAGE_COUNT = 30;
const FILLER = Array.from({ length: 40 }, (_, index) => `  int filler${index} = ${index};`);

function longSource(pkg: string, className: string): string {
  return [
    `package ${pkg};`,
    `public class ${className} {`,
    ...FILLER,
    "  String s = \"scopedneedle\";",
    "}"
  ].join("\n");
}

function buildScopeFixtureEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < OUT_OF_SCOPE_COUNT; i += 1) {
    const n = String(i).padStart(4, "0");
    entries[`aaa/out/ScopedNeedle${n}.java`] =
      `package aaa.out;\npublic class ScopedNeedle${n} { String s = "scopedneedle"; }`;
  }
  // Long sources rank below every short out-of-scope source.
  entries["zzz/scope/ScopedNeedleTarget.java"] = longSource("zzz.scope", "ScopedNeedleTarget");
  // Differs from zzz/scope/ only by case: SQLite LIKE admits it, the
  // case-sensitive scope checks do not.
  entries["zzz/Scope/ScopedNeedleCase.java"] = longSource("zzz.Scope", "ScopedNeedleCase");
  // A literal `_`: an unescaped LIKE would also admit zzz/scope/.
  entries["zzz/sc_pe/ScopedNeedleUnderscore.java"] = longSource("zzz.sc_pe", "ScopedNeedleUnderscore");
  for (let i = 0; i < SCOPED_PAGE_COUNT; i += 1) {
    const n = String(i).padStart(2, "0");
    // Varying lead lines give the hits distinct content-match scores.
    entries[`zzz/many/ScopedNeedleMany${n}.java`] = [
      "package zzz.many;",
      `public class ScopedNeedleMany${n} {`,
      ...FILLER.slice(0, i % 7),
      "  String s = \"scopedneedle\";",
      "}"
    ].join("\n");
  }
  return entries;
}

let scopeFixturePromise: Promise<SearchFixture> | undefined;
function getScopeFixture(): Promise<SearchFixture> {
  scopeFixturePromise ??= createResolvedSearchFixture({
    rootPrefix: "service-indexed-scope-",
    jarBaseName: "server-indexed-scope",
    mapping: "obfuscated",
    sourceEntries: buildScopeFixtureEntries()
  });
  return scopeFixturePromise;
}

const TARGET = "zzz/scope/ScopedNeedleTarget.java";
const scopeCases: Array<{
  name: string;
  scope: { packagePrefix?: string; fileGlob?: string };
  expected: string[];
}> = [
  { name: "packagePrefix", scope: { packagePrefix: "zzz.scope" }, expected: [TARGET] },
  {
    name: "packagePrefix with a literal underscore",
    scope: { packagePrefix: "zzz.sc_pe" },
    expected: ["zzz/sc_pe/ScopedNeedleUnderscore.java"]
  },
  { name: "packagePrefix is case-sensitive", scope: { packagePrefix: "ZZZ.SCOPE" }, expected: [] },
  { name: "fileGlob with a literal directory prefix", scope: { fileGlob: "zzz/scope/*.java" }, expected: [TARGET] },
  {
    name: "packagePrefix plus a fileGlob with a longer literal prefix",
    scope: { packagePrefix: "zzz", fileGlob: "zzz/scope/**" },
    expected: [TARGET]
  },
  {
    name: "packagePrefix plus a fileGlob without a literal prefix",
    scope: { packagePrefix: "zzz.scope", fileGlob: "**/*Target.java" },
    expected: [TARGET]
  }
];

test("SourceService indexed search finds a scoped match behind >500 out-of-scope candidates", async (t) => {
  for (const intent of ["text", "path"] as const) {
    for (const testCase of scopeCases) {
      await t.test(`${intent} intent ${testCase.name}`, async () => {
        const { service, resolved } = await getScopeFixture();
        const result = await service.searchClassSource({
          artifactId: resolved.artifactId,
          query: intent === "text" ? "scopedneedle" : "ScopedNeedle",
          intent,
          // prefix keeps the text window at 500; contains opens the path window to 1000.
          match: intent === "text" ? "prefix" : "contains",
          scope: testCase.scope,
          limit: 20
        });
        assert.deepEqual(result.hits.map((hit) => hit.filePath).sort(), testCase.expected);
      });
    }
  }
});

test("SourceService scoped indexed search pages through every in-scope hit exactly once", async (t) => {
  const { service, resolved } = await getScopeFixture();
  for (const intent of ["text", "path"] as const) {
    await t.test(`${intent} intent`, async () => {
      const base = {
        artifactId: resolved.artifactId,
        query: intent === "text" ? "scopedneedle" : "ScopedNeedle",
        intent,
        match: intent === "text" ? ("prefix" as const) : ("contains" as const),
        scope: { packagePrefix: "zzz.many" }
      };
      const unpaginated = await service.searchClassSource({ ...base, limit: 100 });
      assert.equal(unpaginated.hits.length, SCOPED_PAGE_COUNT);
      assert.equal(unpaginated.nextCursor, undefined);

      const walked: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await service.searchClassSource({ ...base, limit: 7, cursor });
        assert.notEqual(result.cursorIgnored, true);
        walked.push(...result.hits.map((hit) => hit.filePath));
        cursor = result.nextCursor;
        if (!cursor) {
          break;
        }
      }

      assert.equal(cursor, undefined, "the walk must reach the final page");
      assert.equal(new Set(walked).size, walked.length, "no duplicates across pages");
      assert.deepEqual(walked, unpaginated.hits.map((hit) => hit.filePath), "no gaps, same order");
    });
  }
});

// A common token matched by 700 of 3000 files spans more than one candidate
// window and more than one BM25 score band, so the page depends on exactly
// which candidates the window selects. Expectations are the output of the
// release search code on this fixture; an unscoped query must keep them.
function buildCommonTokenEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < 700; i += 1) {
    const n = String(i).padStart(4, "0");
    const lead = " x".repeat((i * 7) % 23);
    const repeats = " commontok".repeat(1 + ((i * 3) % 5));
    const tail = " y".repeat((i * 11) % 31);
    entries[`u/p${i % 9}/F${n}.java`] = `class F${n} {${lead}${repeats}${tail} }`;
  }
  for (let i = 0; i < 2_300; i += 1) {
    entries[`v/G${String(i).padStart(4, "0")}.java`] = `class G${i} { int unrelated; }`;
  }
  return entries;
}

test("SourceService unscoped indexed search keeps its page-one candidates and order", async (t) => {
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-indexed-page-one-",
    jarBaseName: "server-indexed-page-one",
    mapping: "obfuscated",
    sourceEntries: buildCommonTokenEntries()
  });

  await t.test("text intent", async () => {
    const result = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "commontok",
      intent: "text",
      limit: 20
    });
    assert.deepEqual(
      result.hits.map((hit) => `${hit.score} ${hit.filePath}`),
      [
        "333 u/p0/F0000.java", "333 u/p0/F0207.java", "333 u/p0/F0414.java", "333 u/p0/F0621.java",
        "333 u/p1/F0046.java", "333 u/p1/F0253.java", "333 u/p1/F0460.java", "333 u/p1/F0667.java",
        "333 u/p2/F0092.java", "333 u/p2/F0299.java", "333 u/p2/F0506.java", "333 u/p3/F0138.java",
        "333 u/p3/F0345.java", "333 u/p3/F0552.java", "333 u/p4/F0184.java", "333 u/p4/F0391.java",
        "333 u/p4/F0598.java", "333 u/p5/F0023.java", "333 u/p5/F0437.java", "333 u/p5/F0644.java"
      ]
    );
    assert.ok(result.nextCursor);
  });

  await t.test("path intent", async () => {
    const result = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "F0",
      intent: "path",
      match: "contains",
      limit: 20
    });
    assert.deepEqual(
      result.hits.map((hit) => `${hit.score} ${hit.filePath}`),
      [
        "305 u/p0/F0000.java", "305 u/p0/F0009.java", "305 u/p0/F0018.java", "305 u/p0/F0027.java",
        "305 u/p0/F0036.java", "305 u/p0/F0045.java", "305 u/p0/F0054.java", "305 u/p0/F0063.java",
        "305 u/p0/F0072.java", "305 u/p0/F0081.java", "305 u/p0/F0090.java", "305 u/p0/F0099.java",
        "305 u/p0/F0108.java", "305 u/p0/F0117.java", "305 u/p0/F0126.java", "305 u/p0/F0135.java",
        "305 u/p0/F0144.java", "305 u/p0/F0153.java", "305 u/p0/F0162.java", "305 u/p0/F0171.java"
      ]
    );
    assert.ok(result.nextCursor);
  });
});

// 600 early-sorting files fill the 500-row exact/prefix candidate window
// without verifying: their bodies hold both tokens but not the phrase, and
// their paths contain `zzz` but do not start with it. The one real match of
// each intent sorts last and falls outside the window.
function buildWindowEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < 600; i += 1) {
    const n = String(i).padStart(4, "0");
    entries[`aaa/zzz/W${n}.java`] = `class W${n} { String s = "windowtail windowhead"; }`;
  }
  entries["zzz/WindowTarget.java"] = `class WindowTarget { String s = "windowhead windowtail"; ${FILLER.join(" ")} }`;
  return entries;
}

let windowFixturePromise: Promise<SearchFixture> | undefined;
function getWindowFixture(): Promise<SearchFixture> {
  windowFixturePromise ??= createResolvedSearchFixture({
    rootPrefix: "service-indexed-window-",
    jarBaseName: "server-indexed-window",
    mapping: "obfuscated",
    sourceEntries: buildWindowEntries()
  });
  return windowFixturePromise;
}

const WINDOW_WARNING_RE = /candidate window/;

test("SourceService indexed search warns when a short page comes from a full candidate window", async (t) => {
  const { service, resolved } = await getWindowFixture();

  await t.test("text intent", async () => {
    const result = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "windowhead windowtail",
      intent: "text",
      limit: 20
    });
    assert.deepEqual(result.hits, []);
    const warning = result.warnings?.find((entry) => WINDOW_WARNING_RE.test(entry));
    assert.ok(warning, `expected a candidate-window warning, got ${JSON.stringify(result.warnings)}`);
    assert.match(warning, /incomplete/);
    assert.match(warning, /queryMode="literal"/);
    assert.match(warning, /packagePrefix/);

    const literal = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "windowhead windowtail",
      intent: "text",
      queryMode: "literal",
      limit: 20
    });
    assert.deepEqual(literal.hits.map((hit) => hit.filePath), ["zzz/WindowTarget.java"]);
    assert.equal(literal.warnings, undefined);
  });

  await t.test("path intent", async () => {
    const result = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "zzz",
      intent: "path",
      match: "prefix",
      limit: 20
    });
    assert.deepEqual(result.hits, []);
    const warning = result.warnings?.find((entry) => WINDOW_WARNING_RE.test(entry));
    assert.ok(warning, `expected a candidate-window warning, got ${JSON.stringify(result.warnings)}`);
    assert.match(warning, /match="regex"/);
    assert.match(warning, /fileGlob/);
  });
});

test("SourceService indexed search omits the window warning when the window was not full or the page is full", async (t) => {
  const { service, resolved } = await getWindowFixture();

  await t.test("scope narrows the window below its size", async () => {
    for (const intent of ["text", "path"] as const) {
      const result = await service.searchClassSource({
        artifactId: resolved.artifactId,
        query: intent === "text" ? "windowhead" : "zzz",
        intent,
        match: "prefix",
        scope: { packagePrefix: "zzz" },
        limit: 20
      });
      assert.deepEqual(result.hits.map((hit) => hit.filePath), ["zzz/WindowTarget.java"], intent);
      assert.equal(result.warnings, undefined, intent);
    }
  });

  await t.test("a full page from a full window", async () => {
    const result = await service.searchClassSource({
      artifactId: resolved.artifactId,
      query: "windowhead",
      intent: "text",
      limit: 20
    });
    assert.equal(result.hits.length, 20);
    assert.ok(result.nextCursor);
    assert.equal(result.warnings, undefined);
  });
});
