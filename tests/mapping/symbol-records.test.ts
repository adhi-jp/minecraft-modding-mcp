import assert from "node:assert/strict";
import test from "node:test";

import {
  addToSetMap,
  createMethodSymbolRecord,
  normalizedVariants,
  parseFieldName,
  simpleName,
  stripLineInfo
} from "../../src/mapping/parsers/symbol-records.ts";

test("extracts a field name from a type-prefixed declaration and rejects a bare token", () => {
  assert.equal(parseFieldName("int seaLevel"), "seaLevel");
  assert.equal(parseFieldName("seaLevel"), undefined);
});

test("drops a blank or absent descriptor from a directly constructed method record", () => {
  assert.deepEqual(createMethodSymbolRecord("net/minecraft/Block", " tick ", "  "), {
    kind: "method",
    symbol: "net.minecraft.Block.tick",
    owner: "net.minecraft.Block",
    name: "tick",
    descriptor: undefined
  });
  assert.deepEqual(createMethodSymbolRecord("pkg.Cls", "m", undefined), {
    kind: "method",
    symbol: "pkg.Cls.m",
    owner: "pkg.Cls",
    name: "m",
    descriptor: undefined
  });
});

test("strips a method descriptor before taking the trailing simple name", () => {
  assert.equal(simpleName("net.minecraft.Block.tick(IZ)V"), "tick");
});

test("returns the trailing segment of a slash-separated symbol", () => {
  assert.equal(simpleName("net/minecraft/Block"), "Block");
});

test("returns undefined for blank input or a symbol ending in a separator", () => {
  assert.equal(simpleName("   "), undefined);
  assert.equal(simpleName("net.minecraft."), undefined);
});

test("adds a slash-separated variant for a dotted class name", () => {
  assert.deepEqual(normalizedVariants("net.minecraft.Block"), [
    "net.minecraft.Block",
    "net/minecraft/Block"
  ]);
});

test("adds a dotted variant for a slash-separated internal name", () => {
  assert.deepEqual(normalizedVariants("net/minecraft/Block"), [
    "net/minecraft/Block",
    "net.minecraft.Block"
  ]);
});

test("produces both fully-dotted and fully-slashed variants for a mixed-separator symbol", () => {
  assert.deepEqual(normalizedVariants("net/minecraft.Block"), [
    "net/minecraft.Block",
    "net.minecraft.Block",
    "net/minecraft/Block"
  ]);
});

test("returns only the original symbol when it contains no separators", () => {
  assert.deepEqual(normalizedVariants("Block"), ["Block"]);
});

test("ignores blank and whitespace-only keys instead of creating map entries", () => {
  const map = new Map<string, Set<string>>();
  addToSetMap(map, "", "v");
  addToSetMap(map, "   ", "v");
  assert.equal(map.size, 0);
});

test("accumulates distinct values under the trimmed key", () => {
  const map = new Map<string, Set<string>>();
  addToSetMap(map, " key ", "a");
  addToSetMap(map, "key", "b");
  addToSetMap(map, "key", "b");
  assert.equal(map.size, 1);
  assert.deepEqual(map.get("key"), new Set(["a", "b"]));
});

test("strips a single line-info prefix from a method signature", () => {
  assert.equal(stripLineInfo("7:42:void tick()"), "void tick()");
});

test("strips stacked line-info prefixes by looping", () => {
  assert.equal(stripLineInfo("1:2:3:4:void tick()"), "void tick()");
});

test("strips a trailing line-info suffix and trims the result", () => {
  assert.equal(stripLineInfo("void tick():10:20"), "void tick()");
  assert.equal(stripLineInfo("  int seaLevel "), "int seaLevel");
});
