import assert from "node:assert/strict";
import test from "node:test";

import { contentMatchLocation } from "../../src/source/search.ts";
import { extractLineContext } from "../../src/source/shared-utils.ts";
import {
  createResolvedSearchFixture,
  type SearchClassSourceCaseInput,
  type SearchFixture
} from "../helpers/source-service-search-fixtures.ts";

const SOURCE_ENTRIES = {
  "pkg/First.java": [
    "// needleToken on the first line",
    "package pkg;",
    "class First {}"
  ].join("\n"),
  "pkg/Middle.java": [
    "package pkg;",
    "class Middle {",
    "  int needleToken = 1;",
    "  int other = 2;",
    "  int needleTokenAgain = 3;",
    "}"
  ].join("\n"),
  "pkg/Last.java": [
    "package pkg;",
    "class Last {}",
    "// needleToken on the last line"
  ].join("\n")
};

const EXPECTED_LOCATIONS = {
  "pkg/First.java": {
    line: 1,
    context: "// needleToken on the first line\npackage pkg;"
  },
  "pkg/Middle.java": {
    line: 3,
    context: "class Middle {\n  int needleToken = 1;\n  int other = 2;"
  },
  "pkg/Last.java": {
    line: 3,
    context: "class Last {}\n// needleToken on the last line"
  }
};

async function createFixture(): Promise<SearchFixture> {
  return createResolvedSearchFixture({
    rootPrefix: "search-content-line-",
    jarBaseName: "content-line",
    sourceEntries: SOURCE_ENTRIES
  });
}

async function contentHitLocations(fixture: SearchFixture, input: SearchClassSourceCaseInput) {
  const result = await fixture.service.searchClassSource({
    artifactId: fixture.resolved.artifactId,
    ...input
  });
  return {
    reasonCodes: result.hits.map((hit) => hit.reasonCodes),
    locations: Object.fromEntries(
      result.hits
        .filter((hit) => hit.matchedIn === "content")
        .map((hit) => [hit.filePath, { line: hit.line, context: hit.context }])
    )
  };
}

test("searchClassSource indexed text hits carry the first matching line and one line of context on each side", async () => {
  const fixture = await createFixture();
  const { reasonCodes, locations } = await contentHitLocations(fixture, {
    query: "needleToken",
    intent: "text",
    match: "contains",
    limit: 10
  });

  assert.ok(reasonCodes.length > 0 && reasonCodes.every((codes) => codes.includes("indexed")));
  assert.deepEqual(locations, EXPECTED_LOCATIONS);
});

test("searchClassSource literal scan hits carry the first matching line and one line of context on each side", async () => {
  const fixture = await createFixture();
  const { reasonCodes, locations } = await contentHitLocations(fixture, {
    query: "needleToken",
    intent: "text",
    match: "contains",
    queryMode: "literal",
    limit: 10
  });

  assert.ok(reasonCodes.length > 0 && reasonCodes.every((codes) => !codes.includes("indexed")));
  assert.deepEqual(locations, EXPECTED_LOCATIONS);
});

test("searchClassSource regex content hits carry the first matching line and one line of context on each side", async () => {
  const fixture = await createFixture();
  const { locations } = await contentHitLocations(fixture, {
    query: "needle\\w+",
    intent: "text",
    match: "regex",
    limit: 10
  });

  assert.deepEqual(locations, EXPECTED_LOCATIONS);
});

test("searchClassSource path and symbol hits do not carry line or context", async () => {
  const fixture = await createFixture();
  for (const input of [
    { query: "Middle", intent: "path", match: "contains" },
    { query: "Middle", intent: "symbol", match: "exact" }
  ] as const) {
    const result = await fixture.service.searchClassSource({
      artifactId: fixture.resolved.artifactId,
      ...input,
      limit: 10
    });
    assert.ok(result.hits.length > 0, `${input.intent} search must return a hit`);
    for (const hit of result.hits) {
      assert.notEqual(hit.matchedIn, "content");
      assert.equal("line" in hit, false);
      assert.equal("context" in hit, false);
    }
  }
});

test("contentMatchLocation gives the same line and context as splitting the file into lines", () => {
  const contents = [
    "single line needle",
    "needle\n",
    "first\nneedle\n",
    "first\nsecond\nneedle",
    "\nneedle\n\n",
    "first\n\nneedle\n\nlast",
    "first\r\nneedle\r\nlast\r\n"
  ];
  for (const content of contents) {
    for (let index = 0; index < content.length; index += 1) {
      const lineIndex = content.slice(0, index).split("\n").length - 1;
      assert.deepEqual(
        contentMatchLocation(content, index),
        { line: lineIndex + 1, context: extractLineContext(content.split("\n"), lineIndex) },
        `${JSON.stringify(content)} at ${index}`
      );
    }
  }
});

test("contentMatchLocation keeps carriage returns and a trailing newline in the context", () => {
  assert.deepEqual(contentMatchLocation("single line needle", 12), { line: 1, context: "single line needle" });
  assert.deepEqual(contentMatchLocation("first\nneedle\n", 6), { line: 2, context: "first\nneedle\n" });
  assert.deepEqual(contentMatchLocation("first\r\nneedle\r\nlast\r\n", 7), {
    line: 2,
    context: "first\r\nneedle\r\nlast\r"
  });
});
