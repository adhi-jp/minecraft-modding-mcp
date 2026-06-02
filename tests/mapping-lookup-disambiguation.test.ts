import assert from "node:assert/strict";
import test from "node:test";

import { applyDisambiguationHints } from "../src/mapping/lookup.ts";
import type { MappingLookupCandidate } from "../src/mapping/types.ts";

function candidate(name: string, descriptor: string): MappingLookupCandidate {
  return { symbol: `pkg.C.${name}`, matchKind: "exact", confidence: 1, kind: "method", name, descriptor };
}

test("applyDisambiguationHints warns when a descriptorHint matches no candidate", () => {
  const candidates = [candidate("doThing", "(I)V"), candidate("doThing", "(D)V")];
  const warnings: string[] = [];

  // Hint in a namespace/notation that matches neither candidate.
  const result = applyDisambiguationHints(
    candidates,
    { descriptorHint: "(Lnet/minecraft/world/level/Level;)V" },
    warnings
  );

  // Unmatched hint must not silently discard candidates...
  assert.equal(result.length, 2);
  // ...and the omission must be surfaced.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /descriptorHint/);
});

test("applyDisambiguationHints narrows to the matching descriptor without warning", () => {
  const candidates = [candidate("doThing", "(I)V"), candidate("doThing", "(D)V")];
  const warnings: string[] = [];

  const result = applyDisambiguationHints(candidates, { descriptorHint: "(I)V" }, warnings);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.descriptor, "(I)V");
  assert.equal(warnings.length, 0);
});
