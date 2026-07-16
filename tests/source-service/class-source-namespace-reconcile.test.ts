import assert from "node:assert/strict";
import test from "node:test";

import { reconcileUnobfuscatedNamespace } from "../../src/source/class-source.ts";

// Keystone of the unobfuscated token-efficiency fix: an artifact mislabeled as
// "obfuscated" on an unobfuscated version (whose runtime/source names ARE mojang)
// is collapsed to identity so the doomed obfuscated<->mojang remap never runs.

test("reconcile: unobfuscated + mojang request + obfuscated label -> mojang (identity)", () => {
  assert.equal(reconcileUnobfuscatedNamespace("26.2", "mojang", "obfuscated"), "mojang");
});

test("reconcile: obfuscated (legacy) version is left untouched", () => {
  // 1.21.1 is obfuscated; the obfuscated label is real and must be preserved.
  assert.equal(reconcileUnobfuscatedNamespace("1.21.1", "mojang", "obfuscated"), "obfuscated");
});

test("reconcile: only mojang requests are reconciled, not intermediary/yarn/obfuscated", () => {
  // A non-mojang request on unobf keeps its label — collapsing it would invent a mismatch.
  assert.equal(reconcileUnobfuscatedNamespace("26.2", "intermediary", "obfuscated"), "obfuscated");
  assert.equal(reconcileUnobfuscatedNamespace("26.2", "obfuscated", "obfuscated"), "obfuscated");
});

test("reconcile: an already-identity mojang/mojang pair is unchanged", () => {
  assert.equal(reconcileUnobfuscatedNamespace("26.2", "mojang", "mojang"), "mojang");
});

test("reconcile: a missing version is a no-op (cannot prove unobfuscated)", () => {
  assert.equal(reconcileUnobfuscatedNamespace(undefined, "mojang", "obfuscated"), "obfuscated");
});
