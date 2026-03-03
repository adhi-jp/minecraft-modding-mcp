import assert from "node:assert/strict";
import test from "node:test";

import type { SignatureMember } from "../src/minecraft-explorer-service.ts";
import type { ParsedMixin } from "../src/mixin-parser.ts";
import {
  levenshteinDistance,
  suggestSimilar,
  extractMethodName,
  extractMethodDescriptor,
  validateParsedMixin,
  validateParsedAccessWidener,
  type ResolvedTargetMembers,
  type MixinValidationProvenance,
  type ResolvedMember
} from "../src/mixin-validator.ts";
import type { ParsedAccessWidener } from "../src/access-widener-parser.ts";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeMember(overrides: Partial<SignatureMember> & { name: string }): SignatureMember {
  return {
    ownerFqn: "net.minecraft.entity.player.PlayerEntity",
    javaSignature: "void " + overrides.name + "()",
    jvmDescriptor: "()V",
    accessFlags: 1,
    isSynthetic: false,
    ...overrides
  };
}

function makeTargetMembers(className: string, opts: {
  methods?: string[];
  fields?: string[];
  constructors?: string[];
}): ResolvedTargetMembers {
  return {
    className,
    constructors: (opts.constructors ?? []).map((n) => makeMember({ name: n, ownerFqn: className })),
    methods: (opts.methods ?? []).map((n) => makeMember({ name: n, ownerFqn: className })),
    fields: (opts.fields ?? []).map((n) =>
      makeMember({ name: n, ownerFqn: className, javaSignature: "int " + n, jvmDescriptor: "I" })
    )
  };
}

function makeParsedMixin(overrides: Partial<ParsedMixin> = {}): ParsedMixin {
  return {
    className: "TestMixin",
    targets: [{ className: "PlayerEntity" }],
    imports: new Map(),
    injections: [],
    shadows: [],
    accessors: [],
    parseWarnings: [],
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/*  Levenshtein tests                                                  */
/* ------------------------------------------------------------------ */

test("levenshteinDistance returns 0 for identical strings", () => {
  assert.equal(levenshteinDistance("tick", "tick"), 0);
});

test("levenshteinDistance returns correct distance for single edit", () => {
  assert.equal(levenshteinDistance("tick", "tack"), 1);
});

test("levenshteinDistance returns correct distance for insertions", () => {
  assert.equal(levenshteinDistance("tick", "thick"), 1);
});

test("levenshteinDistance handles empty strings", () => {
  assert.equal(levenshteinDistance("", "abc"), 3);
  assert.equal(levenshteinDistance("abc", ""), 3);
  assert.equal(levenshteinDistance("", ""), 0);
});

test("suggestSimilar returns close matches sorted by distance", () => {
  const candidates = ["tick", "tack", "attack", "method", "tickRate"];
  const suggestions = suggestSimilar("tik", candidates);
  assert.ok(suggestions.length > 0);
  assert.equal(suggestions[0], "tick");
});

test("suggestSimilar returns at most maxResults", () => {
  const candidates = ["a", "ab", "abc", "abcd", "abcde"];
  const suggestions = suggestSimilar("a", candidates, 3, 2);
  assert.ok(suggestions.length <= 2);
});

test("suggestSimilar returns empty for no close matches", () => {
  const candidates = ["completelyDifferent"];
  const suggestions = suggestSimilar("tick", candidates, 3);
  assert.equal(suggestions.length, 0);
});

/* ------------------------------------------------------------------ */
/*  Mixin validation tests                                             */
/* ------------------------------------------------------------------ */

test("validateParsedMixin reports target-not-found when class is missing", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "NonExistentClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "target-not-found");
  assert.equal(result.issues[0].target, "NonExistentClass");
});

test("validateParsedMixin reports method-not-found for @Inject with suggestions", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tik", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack", "jump"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "method-not-found");
  assert.ok(result.issues[0].suggestions?.includes("tick"));
});

test("validateParsedMixin reports field-not-found for @Shadow field", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "healht", line: 8 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger", "xp"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].kind, "field-not-found");
  assert.ok(result.issues[0].suggestions?.includes("health"));
});

test("validateParsedMixin reports method-not-found for @Shadow method", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "method", name: "tik", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].kind, "method-not-found");
  assert.equal(result.issues[0].annotation, "@Shadow");
});

test("validateParsedMixin reports error for @Accessor with missing target", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Accessor", name: "getSpeed", targetName: "speed", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].kind, "field-not-found");
  assert.equal(result.issues[0].annotation, "@Accessor");
});

test("validateParsedMixin reports error for @Invoker with missing target", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 14 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].kind, "method-not-found");
  assert.equal(result.issues[0].annotation, "@Invoker");
});

test("validateParsedMixin reports method-not-found for @Invoker when only matching field exists", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 16 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["damage"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "method-not-found");
  assert.equal(result.issues[0].annotation, "@Invoker");
});


test("validateParsedMixin passes when all members are valid", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }],
    shadows: [
      { kind: "field", name: "health", line: 8 },
      { kind: "method", name: "attack", line: 10 }
    ],
    accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", {
      methods: ["tick", "attack"],
      fields: ["health", "hunger"]
    })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.summary.injections, 1);
  assert.equal(result.summary.shadows, 2);
  assert.equal(result.summary.accessors, 1);
  assert.equal(result.summary.total, 4);
});

test("validateParsedMixin includes parse warnings in output", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 3: @Inject missing method attribute."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: [] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.warnings.some((w) => w.includes("missing method attribute")));
});

/* ------------------------------------------------------------------ */
/*  Provenance tests                                                   */
/* ------------------------------------------------------------------ */

test("validateParsedMixin includes provenance when provided", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.deepEqual(result.provenance, provenance);
});

test("validateParsedMixin omits provenance when not provided", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.provenance, undefined);
});

test("validateParsedMixin provenance reflects mapping fallback", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "yarn",
    mappingApplied: "official"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.equal(result.provenance?.requestedMapping, "yarn");
  assert.equal(result.provenance?.mappingApplied, "official");
});

/* ------------------------------------------------------------------ */
/*  Access Widener validation tests                                    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  resolvedMembers tracking                                           */
/* ------------------------------------------------------------------ */

test("validateParsedMixin includes resolvedMembers for resolved injection", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.resolvedMembers);
  assert.equal(result.resolvedMembers!.length, 1);
  assert.equal(result.resolvedMembers![0].status, "resolved");
  assert.equal(result.resolvedMembers![0].resolvedTo, "PlayerEntity#tick");
});

test("validateParsedMixin includes resolvedMembers for not-found shadow", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "missing", line: 8 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.resolvedMembers);
  assert.equal(result.resolvedMembers![0].status, "not-found");
  assert.equal(result.resolvedMembers![0].annotation, "@Shadow");
});

test("validateParsedMixin resolvedMembers tracks accessors", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.resolvedMembers);
  assert.equal(result.resolvedMembers![0].status, "resolved");
  assert.equal(result.resolvedMembers![0].annotation, "@Accessor");
});

test("validateParsedMixin omits resolvedMembers when no members to validate", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.resolvedMembers, undefined);
});

/* ------------------------------------------------------------------ */
/*  target-mapping-failed: mapping failure ≠ target-not-found          */
/* ------------------------------------------------------------------ */

test("validateParsedMixin reports target-mapping-failed when target is in mappingFailedTargets", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "SomeClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const mappingFailedTargets = new Set(["SomeClass"]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailedTargets);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "target-mapping-failed");
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].confidence, "uncertain");
  assert.equal(result.valid, true); // warning, not error
});

test("validateParsedMixin reports target-not-found for non-mapping failures", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const mappingFailedTargets = new Set(["OtherClass"]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailedTargets);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "target-not-found");
  assert.equal(result.issues[0].severity, "error");
});

test("validateParsedMixin distinguishes mapping-failed and not-found in same batch", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MappedClass" }, { className: "GoneClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const mappingFailedTargets = new Set(["MappedClass"]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailedTargets);
  assert.equal(result.issues.length, 2);
  const kinds = result.issues.map((i) => i.kind);
  assert.ok(kinds.includes("target-mapping-failed"));
  assert.ok(kinds.includes("target-not-found"));
});

/* ------------------------------------------------------------------ */
/*  Phase 1: extractMethodName / extractMethodDescriptor tests         */
/* ------------------------------------------------------------------ */

test("extractMethodName strips JVM descriptor from method reference", () => {
  assert.equal(extractMethodName("playerTouch(Lnet/minecraft/world/entity/player/Player;)V"), "playerTouch");
});

test("extractMethodName strips owner prefix and descriptor", () => {
  assert.equal(extractMethodName("Lnet/minecraft/SomeClass;tick(I)V"), "tick");
});

test("extractMethodName keeps method names that start with L", () => {
  assert.equal(extractMethodName("Load(Lfoo/Bar;)V"), "Load");
});

test("extractMethodName returns plain method name as-is", () => {
  assert.equal(extractMethodName("tick"), "tick");
});

test("extractMethodName handles <init> with descriptor", () => {
  assert.equal(extractMethodName("<init>()V"), "<init>");
});

test("extractMethodName handles <init> without descriptor", () => {
  assert.equal(extractMethodName("<init>"), "<init>");
});

test("extractMethodDescriptor extracts descriptor portion", () => {
  assert.equal(
    extractMethodDescriptor("playerTouch(Lnet/minecraft/world/entity/player/Player;)V"),
    "(Lnet/minecraft/world/entity/player/Player;)V"
  );
});

test("extractMethodDescriptor returns undefined for plain name", () => {
  assert.equal(extractMethodDescriptor("tick"), undefined);
});

test("extractMethodDescriptor extracts descriptor after owner prefix", () => {
  assert.equal(extractMethodDescriptor("Lnet/minecraft/SomeClass;tick(I)V"), "(I)V");
});

test("extractMethodDescriptor keeps descriptor for method names that start with L", () => {
  assert.equal(extractMethodDescriptor("Load(Lfoo/Bar;)V"), "(Lfoo/Bar;)V");
});

/* ------------------------------------------------------------------ */
/*  Phase 1: validateInjection with descriptor-bearing references       */
/* ------------------------------------------------------------------ */

test("validateParsedMixin passes injection with descriptor-bearing method reference", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "playerTouch(Lnet/minecraft/world/entity/player/Player;)V", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["playerTouch", "tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("validateParsedMixin passes injection with owner-prefixed method reference", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Redirect", method: "Lnet/minecraft/SomeClass;tick(I)V", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, true);
});

test("validateParsedMixin passes injection when method name starts with L", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "Load(Lfoo/Bar;)V", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["Load"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("validateParsedMixin error message includes descriptor hint", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missingMethod(I)V", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, false);
  assert.ok(result.issues[0].message.includes("(descriptor: (I)V)"));
});

/* ------------------------------------------------------------------ */
/*  Phase 3: @Accessor/@Invoker parse warning escalation               */
/* ------------------------------------------------------------------ */

test("validateParsedMixin escalates @Accessor parse warning to issue", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 5: Could not parse @Accessor method declaration."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].annotation, "@Accessor");
  assert.equal(warnings.length, 0);
});

test("validateParsedMixin escalates @Invoker parse warning to issue", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 8: Could not parse @Invoker method declaration."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].annotation, "@Invoker");
});

test("validateParsedMixin keeps non-accessor parse warnings in warnings[]", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 3: @Inject missing method attribute."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", {})]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues.length, 0);
  assert.ok(warnings.some((w) => w.includes("@Inject")));
});

/* ------------------------------------------------------------------ */
/*  Phase 4: provenance resolutionNotes                                */
/* ------------------------------------------------------------------ */

test("validateParsedMixin provenance includes resolutionNotes when present", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "yarn",
    mappingApplied: "official",
    resolutionNotes: ["Mapping fallback: requested \"yarn\" but applied \"official\" due to remapping failure."]
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.ok(result.provenance?.resolutionNotes);
  assert.equal(result.provenance!.resolutionNotes!.length, 1);
  assert.ok(result.provenance!.resolutionNotes![0].includes("fallback"));
});

/* ------------------------------------------------------------------ */
/*  Phase 5: structuredWarnings                                        */
/* ------------------------------------------------------------------ */

test("validateParsedMixin includes structuredWarnings classified by severity", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [
    "Could not map class \"Foo\" from yarn to official.",
    "Some info message."
  ];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.structuredWarnings);
  assert.equal(result.structuredWarnings!.length, 2);
  assert.equal(result.structuredWarnings![0].severity, "warning");
  assert.equal(result.structuredWarnings![1].severity, "info");
});

test("validateParsedMixin omits structuredWarnings when no warnings", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.structuredWarnings, undefined);
});

/* ------------------------------------------------------------------ */
/*  Confidence classification tests                                    */
/* ------------------------------------------------------------------ */

test("validateParsedMixin with definite confidence marks issues as definite", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance, "definite");
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].confidence, "definite");
  assert.equal(result.summary.definiteErrors, 1);
  assert.equal(result.summary.uncertainErrors, 0);
});

test("validateParsedMixin with uncertain confidence marks issues as uncertain", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "yarn",
    mappingApplied: "official"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance, "uncertain");
  assert.equal(result.valid, true); // uncertain errors only => valid
  assert.equal(result.issues[0].confidence, "uncertain");
  assert.ok(result.issues[0].confidenceReason?.includes("fallback"));
  assert.equal(result.summary.definiteErrors, 0);
  assert.equal(result.summary.uncertainErrors, 1);
});

test("validateParsedMixin with likely confidence", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "noSuchField", line: 8 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "likely");
  assert.equal(result.valid, false); // likely is not uncertain, so definiteError
  assert.equal(result.issues[0].confidence, "likely");
  assert.equal(result.summary.definiteErrors, 1);
});

test("validateParsedMixin provenance supports enriched fields", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    jarType: "vanilla-client",
    mappingChain: ["mojang → official"],
    remapFailures: 3
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.equal(result.provenance?.jarType, "vanilla-client");
  assert.deepEqual(result.provenance?.mappingChain, ["mojang → official"]);
  assert.equal(result.provenance?.remapFailures, 3);
});

test("validateParsedMixin without confidence arg defaults to no confidence on issues", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].confidence, undefined);
  assert.equal(result.summary.definiteErrors, 1); // undefined confidence counts as definite
  assert.equal(result.summary.uncertainErrors, 0);
});

/* ------------------------------------------------------------------ */
/*  unfilteredSummary type support                                     */
/* ------------------------------------------------------------------ */

test("validateParsedMixin result supports unfilteredSummary field", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  // unfilteredSummary is not set by validateParsedMixin itself (set by source-service filtering)
  assert.equal(result.unfilteredSummary, undefined);
  // Verify it can be assigned (type compatibility)
  result.unfilteredSummary = { ...result.summary };
  assert.deepEqual(result.unfilteredSummary, result.summary);
});
