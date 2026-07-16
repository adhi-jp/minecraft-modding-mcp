import assert from "node:assert/strict";
import test from "node:test";

import {
  addToSetMap,
  createMethodSymbolRecord,
  normalizedVariants,
  parseFieldName,
  parseInputSymbol,
  parseMethodName,
  simpleName,
  splitOwnerAndName,
  stripLineInfo
} from "../../src/mapping/parsers/symbol-records.ts";

test("splits a dot-qualified member symbol at the last dot", () => {
  assert.deepEqual(splitOwnerAndName("net.minecraft.world.level.Level.tick"), {
    owner: "net.minecraft.world.level.Level",
    name: "tick"
  });
});

test("splits a slash-separated internal name at the last slash without normalizing", () => {
  assert.deepEqual(splitOwnerAndName("net/minecraft/Block"), {
    owner: "net/minecraft",
    name: "Block"
  });
});

test("prefers the later separator when dots and slashes are mixed", () => {
  assert.deepEqual(splitOwnerAndName("net/minecraft/Block.hardness"), {
    owner: "net/minecraft/Block",
    name: "hardness"
  });
});

test("returns undefined for an unqualified simple name", () => {
  assert.equal(splitOwnerAndName("Block"), undefined);
});

test("returns undefined when the separator is leading or trailing", () => {
  assert.equal(splitOwnerAndName(".Block"), undefined);
  assert.equal(splitOwnerAndName("net.minecraft."), undefined);
});

test("trims surrounding whitespace before locating the separator", () => {
  assert.deepEqual(splitOwnerAndName("  pkg.Cls  "), { owner: "pkg", name: "Cls" });
});

test("extracts the method name from a return-type-prefixed signature", () => {
  assert.equal(parseMethodName("void tick()"), "tick");
  assert.equal(
    parseMethodName("net.minecraft.world.level.Level copy(int[][],java.lang.String[])"),
    "copy"
  );
});

test("returns undefined for a field-style line without parentheses", () => {
  assert.equal(parseMethodName("int seaLevel"), undefined);
});

test("returns undefined when the method signature has no return type before the name", () => {
  assert.equal(parseMethodName("tick()"), undefined);
});

test("extracts a field name from a type-prefixed declaration and rejects a bare token", () => {
  assert.equal(parseFieldName("int seaLevel"), "seaLevel");
  assert.equal(parseFieldName("seaLevel"), undefined);
});

test("parses a descriptor-suffixed symbol into a method record", () => {
  assert.deepEqual(parseInputSymbol("net.minecraft.world.level.Level.tick(Lnet/minecraft/World;)V"), {
    kind: "method",
    symbol: "net.minecraft.world.level.Level.tick(Lnet/minecraft/World;)V",
    owner: "net.minecraft.world.level.Level",
    name: "tick",
    descriptor: "(Lnet/minecraft/World;)V"
  });
});

test("normalizes a slash-form owner to dots in the produced method record", () => {
  assert.deepEqual(parseInputSymbol("net/minecraft/Block.tick()V"), {
    kind: "method",
    symbol: "net.minecraft.Block.tick()V",
    owner: "net.minecraft.Block",
    name: "tick",
    descriptor: "()V"
  });
});

test("classifies a lowercase-leading qualified tail as a field record", () => {
  assert.deepEqual(parseInputSymbol("net.minecraft.world.level.Level.seaLevel"), {
    kind: "field",
    symbol: "net.minecraft.world.level.Level.seaLevel",
    owner: "net.minecraft.world.level.Level",
    name: "seaLevel"
  });
});

test("classifies an uppercase-leading or dollar-leading qualified tail as a class record", () => {
  assert.deepEqual(parseInputSymbol("net.minecraft.world.level.Level"), {
    kind: "class",
    symbol: "net.minecraft.world.level.Level",
    owner: "net.minecraft.world.level",
    name: "Level"
  });
  assert.deepEqual(parseInputSymbol("net.minecraft.$Anonymous"), {
    kind: "class",
    symbol: "net.minecraft.$Anonymous",
    owner: "net.minecraft",
    name: "$Anonymous"
  });
});

test("treats a bare simple name as a class record with no owner", () => {
  // The owner key is present with value undefined; deepEqual distinguishes it from a missing key.
  assert.deepEqual(parseInputSymbol("Level"), {
    kind: "class",
    symbol: "Level",
    owner: undefined,
    name: "Level"
  });
});

test("normalizes a slash-separated class input to a dotted class record", () => {
  assert.deepEqual(parseInputSymbol("net/minecraft/Block"), {
    kind: "class",
    symbol: "net.minecraft.Block",
    owner: "net.minecraft",
    name: "Block"
  });
});

test("returns undefined for an unbalanced descriptor parenthesis", () => {
  assert.equal(parseInputSymbol("net.minecraft.Level.tick(IZ"), undefined);
});

test("returns undefined for a method call shape with no qualified owner", () => {
  assert.equal(parseInputSymbol("tick()V"), undefined);
});

test("returns undefined for empty, whitespace-only, or internally spaced input", () => {
  assert.equal(parseInputSymbol(""), undefined);
  assert.equal(parseInputSymbol("   "), undefined);
  assert.equal(parseInputSymbol("void tick()"), undefined);
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
