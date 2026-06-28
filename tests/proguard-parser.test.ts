import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClientMappings,
  parseProguardMethod,
  proguardTypeToJvm
} from "../src/mapping/parsers/proguard.ts";

// NOTE: ProGuard / Mojang client mappings are emitted post-type-erasure. Generic type
// arguments are already erased to their raw class (so `List<String>` arrives as
// `java.util.List`), and varargs are already lowered to arrays (so `String...` arrives as
// `java.lang.String[]`). These tests therefore exercise the descriptor edge cases in the
// exact shapes the parser actually receives from a real mappings file.

test("proguardTypeToJvm maps primitives to single-character JVM tokens", () => {
  assert.equal(proguardTypeToJvm("void", undefined), "V");
  assert.equal(proguardTypeToJvm("boolean", undefined), "Z");
  assert.equal(proguardTypeToJvm("int", undefined), "I");
  assert.equal(proguardTypeToJvm("long", undefined), "J");
  assert.equal(proguardTypeToJvm("double", undefined), "D");
});

test("proguardTypeToJvm maps a fully-qualified class to an L-descriptor", () => {
  assert.equal(
    proguardTypeToJvm("net.minecraft.world.level.Level", undefined),
    "Lnet/minecraft/world/level/Level;"
  );
});

test("proguardTypeToJvm encodes multi-dimensional arrays with one prefix bracket per dimension", () => {
  assert.equal(proguardTypeToJvm("int[][]", undefined), "[[I");
  assert.equal(proguardTypeToJvm("long[][][]", undefined), "[[[J");
  assert.equal(
    proguardTypeToJvm("net.minecraft.world.level.Level[][]", undefined),
    "[[Lnet/minecraft/world/level/Level;"
  );
});

test("proguardTypeToJvm encodes an erased varargs parameter as a single-dimension array", () => {
  // `String...` is lowered to `java.lang.String[]` in the mappings file.
  assert.equal(proguardTypeToJvm("java.lang.String[]", undefined), "[Ljava/lang/String;");
});

test("proguardTypeToJvm uses the raw class for an erased generic type", () => {
  // `List<String>` is erased to its raw `java.util.List` before reaching the parser.
  assert.equal(proguardTypeToJvm("java.util.List", undefined), "Ljava/util/List;");
});

test("proguardTypeToJvm translates class names through the obfuscation lookup", () => {
  const lookup = new Map<string, string>([
    ["net.minecraft.world.level.Level", "dvk"],
    ["net.minecraft.world.entity.Entity", "bsr"]
  ]);
  assert.equal(proguardTypeToJvm("net.minecraft.world.level.Level", lookup), "Ldvk;");
  // Array dimensions are preserved while the element class is translated.
  assert.equal(proguardTypeToJvm("net.minecraft.world.entity.Entity[]", lookup), "[Lbsr;");
  // Unknown / unmapped classes (e.g. JDK types) fall through unchanged.
  assert.equal(proguardTypeToJvm("java.lang.String", lookup), "Ljava/lang/String;");
});

test("parseProguardMethod assembles a JVM descriptor from return and parameter types", () => {
  assert.deepEqual(parseProguardMethod("void tick()", undefined), {
    name: "tick",
    descriptor: "()V"
  });
  assert.deepEqual(parseProguardMethod("int compare(int,boolean)", undefined), {
    name: "compare",
    descriptor: "(IZ)I"
  });
});

test("parseProguardMethod preserves multi-dim array and erased-varargs parameters", () => {
  assert.deepEqual(
    parseProguardMethod(
      "net.minecraft.world.level.Level copy(int[][],java.lang.String[])",
      undefined
    ),
    {
      name: "copy",
      descriptor: "([[I[Ljava/lang/String;)Lnet/minecraft/world/level/Level;"
    }
  );
});

test("parseProguardMethod translates owner/param classes when given an obfuscation lookup", () => {
  const lookup = new Map<string, string>([
    ["net.minecraft.world.level.Level", "dvk"],
    ["net.minecraft.world.entity.Entity", "bsr"]
  ]);
  // With a lookup the descriptor is in the obfuscated namespace...
  assert.deepEqual(
    parseProguardMethod("void addEntity(net.minecraft.world.entity.Entity)", lookup),
    { name: "addEntity", descriptor: "(Lbsr;)V" }
  );
  // ...and without one it stays in the mojang namespace.
  assert.deepEqual(
    parseProguardMethod("void addEntity(net.minecraft.world.entity.Entity)", undefined),
    { name: "addEntity", descriptor: "(Lnet/minecraft/world/entity/Entity;)V" }
  );
});

test("parseProguardMethod returns undefined for a field-style line without parentheses", () => {
  assert.equal(parseProguardMethod("int field_12345", undefined), undefined);
});

test("parseClientMappings strips line-info prefixes and indexes both directions", () => {
  const text = [
    "# generated mappings",
    "net.minecraft.world.level.Level -> dvk:",
    "    int seaLevel -> a",
    "    7:42:void tick() -> b",
    "    100:140:net.minecraft.world.level.Level copy(int[][]) -> c"
  ].join("\n");

  const result = parseClientMappings(text);

  assert.deepEqual([...result.keys()].sort(), ["mojang->obfuscated", "obfuscated->mojang"]);

  const obfToMojang = result.get("obfuscated->mojang");
  assert.ok(obfToMojang);
  const targetSymbols = new Set([...obfToMojang.records.values()].map((record) => record.symbol));

  // Class + field records carried through to the mojang side.
  assert.ok(targetSymbols.has("net.minecraft.world.level.Level"));
  assert.ok(targetSymbols.has("net.minecraft.world.level.Level.seaLevel"));
  // `7:42:` line-info prefix was stripped before the method name was parsed.
  assert.ok(targetSymbols.has("net.minecraft.world.level.Level.tick()V"));
  // Multi-dim array parameter survives the line-info strip and descriptor assembly.
  assert.ok(
    targetSymbols.has("net.minecraft.world.level.Level.copy([[I)Lnet/minecraft/world/level/Level;")
  );
});

test("parseClientMappings throws MAPPING_UNAVAILABLE when no class mappings are present", () => {
  assert.throws(
    () => parseClientMappings("# only comments\nnot a class mapping line"),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_UNAVAILABLE"
      );
    }
  );
});
