import assert from "node:assert/strict";
import test from "node:test";

import { findContentMatchIndex } from "../../src/source/search.ts";

// Lock in the deliberate semantics: for file *content*, the default text-intent
// match resolves to "prefix" (see normalizeMatch), and content prefix is treated
// as substring/contains rather than start-of-file anchoring. Anchoring would make
// the common default text search return almost nothing.
test("findContentMatchIndex treats content prefix as a substring (contains) match", () => {
  const content = "public void tick() { foo(); }";
  // "tick" appears mid-string; prefix must still find it (contains semantics).
  assert.equal(findContentMatchIndex(content, "tick", "prefix"), content.indexOf("tick"));
  assert.equal(findContentMatchIndex(content, "foo", "prefix"), content.indexOf("foo"));
  // contains behaves identically.
  assert.equal(findContentMatchIndex(content, "tick", "contains"), content.indexOf("tick"));
});

test("findContentMatchIndex exact requires the substring verbatim and is case-sensitive", () => {
  const content = "Hello World";
  assert.equal(findContentMatchIndex(content, "World", "exact"), content.indexOf("World"));
  assert.equal(findContentMatchIndex(content, "world", "exact"), -1);
});

test("findContentMatchIndex returns -1 for an empty query", () => {
  assert.equal(findContentMatchIndex("abc", "", "contains"), -1);
});
