import assert from "node:assert/strict";
import test from "node:test";

import { sliceToMaxCharsSafe } from "../src/text-truncate.ts";

test("sliceToMaxCharsSafe returns text unchanged when within the limit", () => {
  assert.equal(sliceToMaxCharsSafe("hello", 10), "hello");
  assert.equal(sliceToMaxCharsSafe("hello", 5), "hello");
});

test("sliceToMaxCharsSafe slices ASCII at exactly maxChars", () => {
  assert.equal(sliceToMaxCharsSafe("abcdef", 3), "abc");
  assert.equal(sliceToMaxCharsSafe("abcdef", 3).length, 3);
});

test("sliceToMaxCharsSafe never emits a lone high surrogate at the cut", () => {
  // "abc" + U+1F600 (😀, a surrogate pair) + "def". Cutting at 4 would land
  // between the pair's high and low halves.
  const text = "abc\u{1F600}def";
  const cut = sliceToMaxCharsSafe(text, 4);
  assert.equal(cut, "abc", "the dangling high surrogate must be dropped");
  // The result must be a valid string with no lone surrogate.
  const last = cut.charCodeAt(cut.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no trailing high surrogate");
});

test("sliceToMaxCharsSafe keeps a complete surrogate pair that fits", () => {
  const text = "ab\u{1F600}cd"; // 😀 occupies code units 2 and 3
  // maxChars=4 keeps "ab" + full pair.
  const cut = sliceToMaxCharsSafe(text, 4);
  assert.equal(cut, "ab\u{1F600}");
});

test("sliceToMaxCharsSafe handles maxChars <= 0", () => {
  assert.equal(sliceToMaxCharsSafe("abc", 0), "");
});
