import assert from "node:assert/strict";
import test from "node:test";

import {
  createSearchHitAccumulator,
  type SearchCursorPayload,
  type SearchSourceHit
} from "../src/search-hit-accumulator.ts";

function makeHit(
  filePath: string,
  score: number,
  symbolName?: string,
  line = 1
): SearchSourceHit {
  return {
    filePath,
    score,
    matchedIn: "content",
    startLine: line,
    endLine: line,
    snippet: "x",
    reasonCodes: [],
    symbol: symbolName
      ? {
          symbolKind: "method",
          symbolName,
          line
        }
      : undefined
  };
}

test("SearchHitAccumulator keeps only top limit+1 hits while counting total matches", () => {
  const acc = createSearchHitAccumulator(2, undefined);

  acc.add(makeHit("z/Z.java", 1));
  acc.add(makeHit("a/A.java", 100));
  acc.add(makeHit("b/B.java", 90));
  acc.add(makeHit("c/C.java", 80));

  const finalized = acc.finalize();
  assert.equal(finalized.totalApprox, 4);
  assert.equal(finalized.page.length, 2);
  assert.deepEqual(
    finalized.page.map((hit) => [hit.filePath, hit.score]),
    [
      ["a/A.java", 100],
      ["b/B.java", 90]
    ]
  );
  assert.equal(finalized.nextCursorHit?.filePath, "b/B.java");
});

test("SearchHitAccumulator keeps top hits even when better matches arrive after heap is full", () => {
  const acc = createSearchHitAccumulator(2, undefined);

  acc.add(makeHit("0.java", 2));
  acc.add(makeHit("1.java", 4));
  acc.add(makeHit("2.java", 0));
  acc.add(makeHit("3.java", 0));
  acc.add(makeHit("4.java", 5));
  acc.add(makeHit("5.java", 3));

  const finalized = acc.finalize();
  assert.deepEqual(
    finalized.page.map((hit) => [hit.filePath, hit.score]),
    [
      ["4.java", 5],
      ["1.java", 4]
    ]
  );
});

test("SearchHitAccumulator applies cursor filtering before pagination", () => {
  const cursor: SearchCursorPayload = {
    score: 90,
    filePath: "b/B.java",
    symbolName: "",
    line: 1
  };
  const acc = createSearchHitAccumulator(2, cursor);

  acc.add(makeHit("a/A.java", 100));
  acc.add(makeHit("b/B.java", 90));
  acc.add(makeHit("c/C.java", 90));
  acc.add(makeHit("d/D.java", 80));

  const finalized = acc.finalize();
  assert.equal(finalized.totalApprox, 4);
  assert.deepEqual(
    finalized.page.map((hit) => hit.filePath),
    ["c/C.java", "d/D.java"]
  );
  assert.equal(finalized.nextCursorHit, undefined);
});
