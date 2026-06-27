import assert from "node:assert/strict";
import test from "node:test";

import { matchesMemberPattern } from "../src/source/member-pattern.ts";

test("matchesMemberPattern: pipe pattern matches any alternative (B1/B2 regression)", () => {
  const pattern = "getStateForPlacement|canSurvive|setPlacedBy";
  assert.equal(matchesMemberPattern("getStateForPlacement", pattern), true);
  assert.equal(matchesMemberPattern("canSurvive", pattern), true);
  assert.equal(matchesMemberPattern("setPlacedBy", pattern), true);
  assert.equal(matchesMemberPattern("unrelatedMethod", pattern), false);
});

test("matchesMemberPattern: single token keeps substring behavior", () => {
  assert.equal(matchesMemberPattern("tickServer", "tick"), true);
  assert.equal(matchesMemberPattern("field_1", "field"), true);
  assert.equal(matchesMemberPattern("getName", "tick"), false);
});

test("matchesMemberPattern: case-insensitive on both sides", () => {
  assert.equal(matchesMemberPattern("getStateForPlacement", "STATEFOR"), true);
  assert.equal(matchesMemberPattern("GETSTATE", "getstate"), true);
});

test("matchesMemberPattern: empty and whitespace alternatives are ignored", () => {
  // trailing / doubled / surrounding pipes collapse to the real alternatives
  assert.equal(matchesMemberPattern("canSurvive", "canSurvive|"), true);
  assert.equal(matchesMemberPattern("canSurvive", "|canSurvive"), true);
  assert.equal(matchesMemberPattern("canSurvive", "a||canSurvive"), true);
  assert.equal(matchesMemberPattern("canSurvive", "  canSurvive  "), true);
});

test("matchesMemberPattern: no usable alternative matches nothing", () => {
  assert.equal(matchesMemberPattern("anything", "|||"), false);
  assert.equal(matchesMemberPattern("anything", "   "), false);
});
