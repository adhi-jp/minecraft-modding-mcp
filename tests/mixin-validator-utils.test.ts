import assert from "node:assert/strict";
import test from "node:test";

import {
  levenshteinDistance,
  suggestSimilar,
  extractMethodName,
  extractMethodDescriptor,
  validateParsedAccessWidener,
  validateParsedAccessTransformer,
  type ResolvedTargetMembers
} from "../src/mixin-validator.ts";
import type { ParsedAccessWidener } from "../src/access-widener-parser.ts";
import { parseAccessTransformer } from "../src/access-transformer-parser.ts";
import { makeMember, makeTargetMembers } from "./helpers/mixin-validator-fixtures.ts";

test("levenshteinDistance handles representative edit-distance cases", () => {
  const cases = [
    { name: "identical strings", a: "tick", b: "tick", distance: 0 },
    { name: "single edit", a: "tick", b: "tack", distance: 1 },
    { name: "insertion", a: "tick", b: "thick", distance: 1 },
    { name: "empty lhs", a: "", b: "abc", distance: 3 },
    { name: "empty rhs", a: "abc", b: "", distance: 3 },
    { name: "both empty", a: "", b: "", distance: 0 }
  ];

  for (const testCase of cases) {
    assert.equal(
      levenshteinDistance(testCase.a, testCase.b),
      testCase.distance,
      testCase.name
    );
  }
});

test("suggestSimilar handles ranking, truncation, and empty results", () => {
  const cases = [
    {
      name: "close matches stay sorted by distance",
      input: "tik",
      candidates: ["tick", "tack", "attack", "method", "tickRate"],
      maxDistance: 3,
      first: "tick",
      minLength: 1
    },
    {
      name: "maxResults caps output length",
      input: "a",
      candidates: ["a", "ab", "abc", "abcd", "abcde"],
      maxDistance: 3,
      maxResults: 2,
      maxLength: 2
    },
    {
      name: "no close matches returns empty list",
      input: "tick",
      candidates: ["completelyDifferent"],
      maxDistance: 3,
      expected: []
    }
  ];

  for (const testCase of cases) {
    const suggestions = suggestSimilar(
      testCase.input,
      testCase.candidates,
      testCase.maxDistance,
      testCase.maxResults
    );

    if (testCase.expected !== undefined) {
      assert.deepEqual(suggestions, testCase.expected, testCase.name);
      continue;
    }
    if (testCase.first !== undefined) {
      assert.equal(suggestions[0], testCase.first, testCase.name);
    }
    if (testCase.minLength !== undefined) {
      assert.ok(suggestions.length >= testCase.minLength, testCase.name);
    }
    if (testCase.maxLength !== undefined) {
      assert.ok(suggestions.length <= testCase.maxLength, testCase.name);
    }
  }
});

test("extractMethodName strips descriptors and owner prefixes across supported forms", () => {
  const cases = [
    {
      name: "descriptor-bearing method reference",
      ref: "playerTouch(Lnet/minecraft/world/entity/player/Player;)V",
      expected: "playerTouch"
    },
    {
      name: "owner-prefixed method reference",
      ref: "Lnet/minecraft/SomeClass;tick(I)V",
      expected: "tick"
    },
    {
      name: "method name starting with L",
      ref: "Load(Lfoo/Bar;)V",
      expected: "Load"
    },
    {
      name: "plain method name",
      ref: "tick",
      expected: "tick"
    },
    {
      name: "<init> with descriptor",
      ref: "<init>()V",
      expected: "<init>"
    },
    {
      name: "<init> without descriptor",
      ref: "<init>",
      expected: "<init>"
    }
  ];

  for (const testCase of cases) {
    assert.equal(extractMethodName(testCase.ref), testCase.expected, testCase.name);
  }
});

test("extractMethodDescriptor returns the descriptor portion when present", () => {
  const cases = [
    {
      name: "descriptor-bearing method reference",
      ref: "playerTouch(Lnet/minecraft/world/entity/player/Player;)V",
      expected: "(Lnet/minecraft/world/entity/player/Player;)V"
    },
    {
      name: "plain method name",
      ref: "tick",
      expected: undefined
    },
    {
      name: "owner-prefixed method reference",
      ref: "Lnet/minecraft/SomeClass;tick(I)V",
      expected: "(I)V"
    },
    {
      name: "method name starting with L",
      ref: "Load(Lfoo/Bar;)V",
      expected: "(Lfoo/Bar;)V"
    }
  ];

  for (const testCase of cases) {
    assert.equal(extractMethodDescriptor(testCase.ref), testCase.expected, testCase.name);
  }
});

test("validateParsedAccessWidener validates class entry", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [
      { line: 2, kind: "accessible", targetKind: "class", target: "net/minecraft/server/MinecraftServer" }
    ],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["net.minecraft.server.MinecraftServer", makeTargetMembers("net.minecraft.server.MinecraftServer", {})]
  ]);
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.entries[0].valid, true);
});

test("validateParsedAccessWidener reports missing class", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [
      { line: 2, kind: "accessible", targetKind: "class", target: "net/minecraft/server/FakeClass" }
    ],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.entries[0].valid, false);
  assert.ok(result.entries[0].issue?.includes("not found"));
});

test("validateParsedAccessWidener validates method entry with descriptor", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [{
      line: 2,
      kind: "accessible",
      targetKind: "method",
      target: "net/minecraft/server/MinecraftServer",
      owner: "net/minecraft/server/MinecraftServer",
      name: "tick",
      descriptor: "()V"
    }],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["net.minecraft.server.MinecraftServer", makeTargetMembers("net.minecraft.server.MinecraftServer", {
      methods: ["tick"]
    })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.entries[0].valid, true);
});

test("validateParsedAccessWidener reports missing method with suggestions", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [{
      line: 2,
      kind: "accessible",
      targetKind: "method",
      target: "net/minecraft/server/MinecraftServer",
      owner: "net/minecraft/server/MinecraftServer",
      name: "tik",
      descriptor: "()V"
    }],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["net.minecraft.server.MinecraftServer", makeTargetMembers("net.minecraft.server.MinecraftServer", {
      methods: ["tick", "stop"]
    })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.entries[0].valid, false);
  assert.ok(result.entries[0].suggestions?.includes("tick"));
});

test("validateParsedAccessWidener validates field entry", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [{
      line: 2,
      kind: "mutable",
      targetKind: "field",
      target: "net/minecraft/server/MinecraftServer",
      owner: "net/minecraft/server/MinecraftServer",
      name: "running",
      descriptor: "I"
    }],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["net.minecraft.server.MinecraftServer", makeTargetMembers("net.minecraft.server.MinecraftServer", {
      fields: ["running"]
    })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.valid, true);
});

test("validateParsedAccessWidener summary counts", () => {
  const parsed: ParsedAccessWidener = {
    headerVersion: "v2",
    namespace: "intermediary",
    entries: [
      { line: 2, kind: "accessible", targetKind: "class", target: "net/minecraft/server/MinecraftServer" },
      {
        line: 3, kind: "accessible", targetKind: "method",
        target: "net/minecraft/server/MinecraftServer",
        owner: "net/minecraft/server/MinecraftServer",
        name: "missing", descriptor: "()V"
      }
    ],
    parseWarnings: []
  };
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["net.minecraft.server.MinecraftServer", makeTargetMembers("net.minecraft.server.MinecraftServer", {
      methods: ["tick"]
    })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedAccessWidener(parsed, membersByClass, warnings);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.valid, 1);
  assert.equal(result.summary.invalid, 1);
});

test("validateParsedAccessTransformer treats wildcard targets as valid when the owner resolves", () => {
  const parsed = parseAccessTransformer([
    "public com.example.Foo *",
    "public com.example.Foo *()"
  ].join("\n"));
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["com.example.Foo", {
      className: "com.example.Foo",
      constructors: [],
      methods: [makeMember({ name: "bar", ownerFqn: "com.example.Foo", jvmDescriptor: "()V" })],
      fields: [makeMember({ name: "baz", ownerFqn: "com.example.Foo", jvmDescriptor: "I" })]
    }]
  ]);
  const result = validateParsedAccessTransformer(parsed, membersByClass, []);
  assert.equal(result.valid, true, `wildcards should be valid, got ${JSON.stringify(result.entries)}`);
  assert.equal(result.entries.every((e) => e.valid), true);
});

test("validateParsedAccessTransformer reports a descriptor mismatch with candidates", () => {
  const parsed = parseAccessTransformer("public com.example.Foo bar(D)V");
  const membersByClass = new Map<string, ResolvedTargetMembers>([
    ["com.example.Foo", {
      className: "com.example.Foo",
      constructors: [],
      methods: [makeMember({ name: "bar", ownerFqn: "com.example.Foo", jvmDescriptor: "(I)V" })],
      fields: []
    }]
  ]);
  const result = validateParsedAccessTransformer(parsed, membersByClass, []);
  assert.equal(result.valid, false);
  assert.ok(result.entries[0]?.issue?.includes("(I)V"), "issue should list the available descriptor");
});
