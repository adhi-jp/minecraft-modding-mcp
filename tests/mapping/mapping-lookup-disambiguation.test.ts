import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDisambiguationHints,
  consumeFieldType,
  isValidMethodDescriptor
} from "../../src/mapping/lookup.ts";
import type { MappingLookupCandidate } from "../../src/mapping/types.ts";

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

test("isValidMethodDescriptor enforces the 255-dimension array limit", () => {
  // JVM §4.3.2 caps array descriptors at 255 dimensions; 255 is the boundary that is
  // still valid, 256 must be rejected so pathological keys cannot slip through.
  assert.equal(isValidMethodDescriptor(`(${"[".repeat(255)}I)V`), true);
  assert.equal(isValidMethodDescriptor(`(${"[".repeat(256)}I)V`), false);
});

test("consumeFieldType rejects array depth beyond 255 dimensions", () => {
  // 255 leading brackets + element token "I" consumes the whole token (returns end index 256).
  assert.equal(consumeFieldType(`${"[".repeat(255)}I`, 0, false), 256);
  // 256 brackets exceeds the guard and is rejected with -1.
  assert.equal(consumeFieldType(`${"[".repeat(256)}I`, 0, false), -1);
});

test("isValidMethodDescriptor rejects void nested inside an array element", () => {
  // Void is only legal as a bare return type, never as an array element type.
  assert.equal(isValidMethodDescriptor("()V"), true);
  assert.equal(isValidMethodDescriptor("()[V"), false);
  assert.equal(isValidMethodDescriptor("([V)V"), false);
});

test("consumeFieldType rejects void as an array element but allows a bare void return", () => {
  assert.equal(consumeFieldType("V", 0, true), 1);
  assert.equal(consumeFieldType("[V", 0, true), -1);
});

test("isValidMethodDescriptor rejects an empty reference type L;", () => {
  // "L;" has an empty class name and must not be accepted as a reference descriptor.
  assert.equal(isValidMethodDescriptor("(L;)V"), false);
  assert.equal(isValidMethodDescriptor("()L;"), false);
  assert.equal(isValidMethodDescriptor("(Lfoo/Bar;)V"), true);
});

test("consumeFieldType rejects an empty L; reference token", () => {
  assert.equal(consumeFieldType("L;", 0, false), -1);
  assert.equal(consumeFieldType("Lfoo/Bar;", 0, false), 9);
});
