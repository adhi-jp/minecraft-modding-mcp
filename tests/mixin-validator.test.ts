import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  type MappingHealthReport,
  type ResolvedMember,
  type IssueCategory,
  type ResolutionPath
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

test("suggestSimilar skips candidates whose length gap already exceeds maxDistance", async () => {
  const source = await readFile("src/mixin-validator.ts", "utf8");
  const block =
    source.match(/export function suggestSimilar\([\s\S]*?return scored\.slice\(0, maxResults\)\.map\(\(s\) => s\.candidate\);\n\}/)?.[0] ?? "";

  assert.match(block, /Math\.abs\(normalizedName\.length - normalizedCandidate\.length\) > maxDistance/);
});

test("validateParsedMixin hoists warning-classifier regexes out of the hot function body", async () => {
  const source = await readFile("src/mixin-validator.ts", "utf8");
  const block =
    source.match(/export function validateParsedMixin\([\s\S]*?const structuredWarnings: StructuredWarning\[] = warnings\.map/)?.[0] ?? "";

  assert.doesNotMatch(block, /const MAPPING_WARNING_RE =/);
  assert.match(source, /const MAPPING_WARNING_RE = /);
  assert.match(source, /const CONFIG_WARNING_RE = /);
  assert.match(source, /const PARSE_WARNING_RE = /);
});

/* ------------------------------------------------------------------ */
/*  Mixin validation tests                                             */
/* ------------------------------------------------------------------ */

test("validateParsedMixin reports representative member-validation outcomes", () => {
  const cases = [
    {
      name: "target-not-found when class is missing",
      parsed: makeParsedMixin({ targets: [{ className: "NonExistentClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "target-not-found", target: "NonExistentClass" }
    },
    {
      name: "method-not-found for @Inject with suggestions",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tik", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack", "jump"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", suggestionsInclude: "tick" }
    },
    {
      name: "field-not-found for @Shadow field",
      parsed: makeParsedMixin({
        shadows: [{ kind: "field", name: "healht", line: 8 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger", "xp"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "field-not-found", suggestionsInclude: "health" }
    },
    {
      name: "method-not-found for @Shadow method",
      parsed: makeParsedMixin({
        shadows: [{ kind: "method", name: "tik", line: 10 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Shadow" }
    },
    {
      name: "field-not-found for @Accessor target",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Accessor", name: "getSpeed", targetName: "speed", line: 12 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "field-not-found", annotation: "@Accessor" }
    },
    {
      name: "method-not-found for @Invoker target",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 14 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Invoker" }
    },
    {
      name: "@Invoker stays method-not-found when only matching field exists",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 16 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["damage"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Invoker" }
    },
    {
      name: "all members valid",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 5 }],
        shadows: [
          { kind: "field", name: "health", line: 8 },
          { kind: "method", name: "attack", line: 10 }
        ],
        accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", {
          methods: ["tick", "attack"],
          fields: ["health", "hunger"]
        })]
      ]),
      expectedValid: true,
      expectedIssueCount: 0,
      expectedSummary: { injections: 1, shadows: 2, accessors: 1, total: 4 }
    }
  ] as const;

  for (const testCase of cases) {
    const warnings: string[] = [];
    const result = validateParsedMixin(testCase.parsed, testCase.targetMembers, warnings);

    assert.equal(result.valid, testCase.expectedValid, `${testCase.name}: valid`);
    assert.equal(result.issues.length, testCase.expectedIssueCount, `${testCase.name}: issue count`);

    if (testCase.expectedIssueCount > 0) {
      const issue = result.issues[0];
      assert.equal(issue.kind, testCase.expectedIssue?.kind, `${testCase.name}: issue kind`);
      if (testCase.expectedIssue?.target !== undefined) {
        assert.equal(issue.target, testCase.expectedIssue.target, `${testCase.name}: issue target`);
      }
      if (testCase.expectedIssue?.annotation !== undefined) {
        assert.equal(issue.annotation, testCase.expectedIssue.annotation, `${testCase.name}: issue annotation`);
      }
      if (testCase.expectedIssue?.suggestionsInclude !== undefined) {
        assert.ok(
          issue.suggestions?.includes(testCase.expectedIssue.suggestionsInclude),
          `${testCase.name}: suggestions`
        );
      }
    }

    if (testCase.expectedSummary !== undefined) {
      assert.equal(result.summary.injections, testCase.expectedSummary.injections, `${testCase.name}: injections`);
      assert.equal(result.summary.shadows, testCase.expectedSummary.shadows, `${testCase.name}: shadows`);
      assert.equal(result.summary.accessors, testCase.expectedSummary.accessors, `${testCase.name}: accessors`);
      assert.equal(result.summary.total, testCase.expectedSummary.total, `${testCase.name}: total`);
    }
  }
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
    mappingApplied: "obfuscated"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.equal(result.provenance?.requestedMapping, "yarn");
  assert.equal(result.provenance?.mappingApplied, "obfuscated");
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
/*  explain mode                                                       */
/* ------------------------------------------------------------------ */

test("validateParsedMixin explain=true adds explanation to target-not-found", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance, undefined, undefined, true);
  assert.ok(result.issues[0].explanation);
  assert.ok(result.issues[0].suggestedCall);
  assert.equal(result.issues[0].suggestedCall!.tool, "check-symbol-exists");
  assert.equal(result.issues[0].suggestedCall!.params.kind, "class");
  assert.equal(result.issues[0].suggestedCall!.params.name, "MissingClass");
  assert.equal(result.issues[0].suggestedCall!.params.version, "1.21");
  assert.equal(result.issues[0].suggestedCall!.params.sourceMapping, "mojang");
  assert.equal(result.issues[0].suggestedCall!.params.nameMode, "auto");
});

test("validateParsedMixin explain=true adds suggestedCall for method-not-found", () => {
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

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance, undefined, undefined, true);
  const issue = result.issues[0];
  assert.ok(issue.suggestedCall);
  assert.equal(issue.suggestedCall!.tool, "get-class-source");
  assert.equal(issue.suggestedCall!.params.mode, "metadata");
  assert.deepEqual(issue.suggestedCall!.params.target, {
    type: "resolve",
    kind: "version",
    value: "1.21"
  });
  assert.equal(issue.suggestedCall!.params.targetKind, undefined);
  assert.equal(issue.suggestedCall!.params.targetValue, undefined);
  assert.equal(issue.suggestedCall!.params.version, undefined);
});

test("validateParsedMixin explain=true field-not-found omits signatureMode", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "missingField", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance, undefined, undefined, true);
  const issue = result.issues.find((i) => i.kind === "field-not-found");
  assert.ok(issue, "expected field-not-found issue");
  assert.ok(issue!.suggestedCall);
  assert.equal(issue!.suggestedCall!.tool, "check-symbol-exists");
  assert.equal(issue!.suggestedCall!.params.kind, "field");
  assert.equal(issue!.suggestedCall!.params.signatureMode, undefined);
  assert.equal(issue!.suggestedCall!.params.version, "1.21");
  assert.equal(issue!.suggestedCall!.params.sourceMapping, "mojang");
});

test("validateParsedMixin explain=true omits check-symbol-exists unsupported context fields", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, true,
    undefined, undefined,
    { scope: "merged", sourcePriority: "loom-first", projectPath: "/my/project", mapping: "mojang" }
  );

  const params = result.issues[0].suggestedCall!.params;
  assert.equal(params.sourcePriority, "loom-first");
  assert.equal(params.scope, undefined);
  assert.equal(params.projectPath, undefined);
  assert.equal(params.mapping, undefined);
  assert.equal(params.sourceMapping, "mojang");
});

test("validateParsedMixin explain=true omits suggestedCall when provenance is missing", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, undefined, true);
  assert.ok(result.issues[0].explanation);
  assert.equal(result.issues[0].suggestedCall, undefined);
});

test("validateParsedMixin explain=false omits explanation and suggestedCall", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].explanation, undefined);
  assert.equal(result.issues[0].suggestedCall, undefined);
});

/* ------------------------------------------------------------------ */
/*  category classification                                            */
/* ------------------------------------------------------------------ */

test("validateParsedMixin target-mapping-failed has category=mapping", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "SomeClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailedTargets = new Set(["SomeClass"]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailedTargets);
  assert.equal(result.issues[0].category, "mapping");
});

test("validateParsedMixin validation issues have category=validation", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].category, "validation");
});

test("validateParsedMixin structuredWarnings have category", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [
    "Could not remap field from yarn to obfuscated.",
    "Overriding version with project version from gradle.properties.",
    "Some generic info."
  ];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.structuredWarnings);
  assert.equal(result.structuredWarnings![0].category, "mapping");
  assert.equal(result.structuredWarnings![1].category, "configuration");
  assert.equal(result.structuredWarnings![2].category, "validation");
});

/* ------------------------------------------------------------------ */
/*  Phase 1: extractMethodName / extractMethodDescriptor tests         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Phase 1: validateInjection with descriptor-bearing references       */
/* ------------------------------------------------------------------ */

test("validateParsedMixin handles descriptor-bearing and owner-prefixed method references", () => {
  const cases = [
    {
      name: "descriptor-bearing method reference",
      annotation: "Inject",
      method: "playerTouch(Lnet/minecraft/world/entity/player/Player;)V",
      availableMethods: ["playerTouch", "tick"],
      valid: true
    },
    {
      name: "owner-prefixed method reference",
      annotation: "Redirect",
      method: "Lnet/minecraft/SomeClass;tick(I)V",
      availableMethods: ["tick"],
      valid: true
    },
    {
      name: "method name starting with L",
      annotation: "Inject",
      method: "Load(Lfoo/Bar;)V",
      availableMethods: ["Load"],
      valid: true
    },
    {
      name: "missing method keeps descriptor hint",
      annotation: "Inject",
      method: "missingMethod(I)V",
      availableMethods: ["tick"],
      valid: false,
      issueMessageIncludes: "(descriptor: (I)V)"
    }
  ] as const;

  for (const testCase of cases) {
    const parsed = makeParsedMixin({
      injections: [{ annotation: testCase.annotation, method: testCase.method, line: 10 }]
    });
    const targetMembers = new Map<string, ResolvedTargetMembers>([
      ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: testCase.availableMethods })]
    ]);
    const warnings: string[] = [];

    const result = validateParsedMixin(parsed, targetMembers, warnings);

    assert.equal(result.valid, testCase.valid, testCase.name);
    if (testCase.valid) {
      assert.equal(result.issues.length, 0, testCase.name);
      continue;
    }
    assert.equal(result.issues.length, 1, testCase.name);
    assert.ok(
      result.issues[0].message.includes(testCase.issueMessageIncludes!),
      testCase.name
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Phase 3: @Accessor/@Invoker parse warning escalation               */
/* ------------------------------------------------------------------ */

test("validateParsedMixin escalates @Accessor parse warning to issue with parse category", () => {
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
  assert.equal(result.issues[0].category, "parse");
  assert.equal(result.issues[0].issueOrigin, "parser_limitation");
  assert.equal(result.issues[0].falsePositiveRisk, "high");
  assert.equal(warnings.length, 0);
});

test("validateParsedMixin escalates @Invoker parse warning to issue with parse category", () => {
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
  assert.equal(result.issues[0].category, "parse");
  assert.equal(result.issues[0].issueOrigin, "parser_limitation");
});

test("validateParsedMixin escalates @Shadow parse warning to issue", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 10: Could not parse @Shadow member declaration."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].annotation, "@Shadow");
  assert.equal(result.issues[0].category, "parse");
  assert.equal(result.issues[0].issueOrigin, "parser_limitation");
  assert.equal(result.issues[0].falsePositiveRisk, "high");
  assert.equal(warnings.length, 0);
});

test("validateParsedMixin adds contradiction note when parse fails but same annotation resolves", () => {
  const parsed: ParsedMixin = {
    className: "TestMixin",
    targets: [{ className: "PlayerEntity" }],
    imports: new Map(),
    injections: [],
    shadows: [{ kind: "field", name: "health", line: 5 }],
    accessors: [],
    parseWarnings: ["Line 10: Could not parse @Shadow member declaration."]
  };
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  // The @Shadow field "health" should resolve, and the parse warning should note the contradiction
  const parseIssue = result.issues.find((i) => i.category === "parse");
  assert.ok(parseIssue);
  assert.ok(parseIssue!.message.includes("other members with the same annotation resolved successfully"));
});

test("validateParsedMixin summary includes parseWarnings count", () => {
  const parsed = makeParsedMixin({
    parseWarnings: [
      "Line 5: Could not parse @Accessor method declaration.",
      "Line 8: Could not parse @Shadow member declaration."
    ]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.summary.parseWarnings, 2);
});

test("validateParsedMixin keeps non-accessor/shadow parse warnings in warnings[]", () => {
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
  assert.equal(result.summary.parseWarnings, 0);
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
    mappingApplied: "obfuscated",
    resolutionNotes: ["Mapping fallback: requested \"yarn\" but applied \"obfuscated\" due to remapping failure."]
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
    "Could not map class \"Foo\" from yarn to obfuscated.",
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
    mappingApplied: "obfuscated"
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
    mappingChain: ["mojang → obfuscated"],
    remapFailures: 3
  };

  const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
  assert.equal(result.provenance?.jarType, "vanilla-client");
  assert.deepEqual(result.provenance?.mappingChain, ["mojang → obfuscated"]);
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

/* ------------------------------------------------------------------ */
/*  P2: remap-failed false positive fix                                */
/* ------------------------------------------------------------------ */

test("validateParsedMixin downgrades confidence to uncertain for remap-failed members", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "obfuscatedName", line: 5 }],
    shadows: [{ kind: "field", name: "obfField", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"], fields: ["health"] })]
  ]);
  const warnings: string[] = [];
  const remapFailedMembers = new Map<string, Set<string>>([
    ["PlayerEntity", new Set(["obfuscatedName", "obfField"])]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "definite", undefined, false, remapFailedMembers);

  // Both issues should be downgraded to uncertain due to remap failure
  assert.equal(result.issues.length, 2);
  for (const issue of result.issues) {
    assert.equal(issue.confidence, "uncertain");
    assert.ok(issue.confidenceReason?.includes("remap artifact"));
    assert.equal(issue.resolutionPath, "member-remap-failed");
  }
  assert.equal(result.summary.uncertainErrors, 2);
  assert.equal(result.summary.definiteErrors, 0);
});

test("validateParsedMixin keeps definite confidence for non-remap-failed members", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "trulyMissing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  // remapFailedMembers has a different name — not the one in the injection
  const remapFailedMembers = new Map<string, Set<string>>([
    ["PlayerEntity", new Set(["otherMethod"])]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "definite", undefined, false, remapFailedMembers);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].confidence, "definite");
  assert.equal(result.issues[0].resolutionPath, undefined);
});

test("validateParsedMixin applies remap-failed downgrade per target only", () => {
  const parsed = makeParsedMixin({
    targets: [{ className: "PlayerEntity" }, { className: "MobEntity" }],
    injections: [{ annotation: "Inject", method: "missingMethod", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })],
    ["MobEntity", makeTargetMembers("MobEntity", { methods: ["move"] })]
  ]);
  const warnings: string[] = [];
  const remapFailedMembers = new Map<string, Set<string>>([
    ["PlayerEntity", new Set(["missingMethod"])]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "definite", undefined, false, remapFailedMembers);
  assert.equal(result.issues.length, 2);

  const playerIssue = result.issues.find((i) => i.target.startsWith("PlayerEntity#"));
  const mobIssue = result.issues.find((i) => i.target.startsWith("MobEntity#"));

  assert.equal(playerIssue?.confidence, "uncertain");
  assert.equal(playerIssue?.resolutionPath, "member-remap-failed");
  assert.equal(mobIssue?.confidence, "definite");
  assert.equal(mobIssue?.resolutionPath, undefined);
});

/* ------------------------------------------------------------------ */
/*  P3: resolutionPath values                                          */
/* ------------------------------------------------------------------ */

test("validateParsedMixin sets resolutionPath=target-class-missing for true not-found", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].resolutionPath, "target-class-missing");
});

test("validateParsedMixin sets resolutionPath=target-mapping-failed for mapping failures", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MappedClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailedTargets = new Set(["MappedClass"]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailedTargets);
  assert.equal(result.issues[0].resolutionPath, "target-mapping-failed");
});

test("validateParsedMixin sets resolutionPath=source-signature-unavailable for sig-failed targets", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "SigFailClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const signatureFailedTargets = new Set(["SigFailClass"]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, undefined, false, undefined, signatureFailedTargets);
  assert.equal(result.issues[0].resolutionPath, "source-signature-unavailable");
  assert.equal(result.issues[0].category, "resolution");
});

test("validateParsedMixin sets resolutionPath=member-remap-failed for remap-failed member issues", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Invoker", name: "invokeObf", targetName: "obfMethod", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const remapFailedMembers = new Map<string, Set<string>>([
    ["PlayerEntity", new Set(["obfMethod"])]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "definite", undefined, false, remapFailedMembers);
  assert.equal(result.issues[0].resolutionPath, "member-remap-failed");
  assert.equal(result.issues[0].confidence, "uncertain");
});

/* ------------------------------------------------------------------ */
/*  P4: two-layer classification                                       */
/* ------------------------------------------------------------------ */

test("validateParsedMixin assigns category=resolution when resolutionPath is set", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "obfName", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const remapFailedMembers = new Map<string, Set<string>>([
    ["PlayerEntity", new Set(["obfName"])]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "definite", undefined, false, remapFailedMembers);
  assert.equal(result.issues[0].category, "resolution");
  assert.equal(result.summary.resolutionErrors, 1);
});

test("validateParsedMixin keeps category=validation for true validation errors", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missing", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].category, "validation");
  assert.equal(result.issues[0].resolutionPath, undefined);
  assert.equal(result.summary.resolutionErrors, 0);
});

/* ------------------------------------------------------------------ */
/*  P5: suggestedCall context propagation                              */
/* ------------------------------------------------------------------ */

test("validateParsedMixin explain=true only propagates schema-valid context fields for check-symbol-exists", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const provenance: MixinValidationProvenance = {
    version: "1.21",
    jarPath: "/path/to/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, true,
    undefined, undefined,
    { scope: "merged", sourcePriority: "loom-first", projectPath: "/my/project", mapping: "mojang" }
  );
  const params = result.issues[0].suggestedCall!.params;
  assert.equal(params.sourcePriority, "loom-first");
  assert.equal(params.scope, undefined);
  assert.equal(params.projectPath, undefined);
  assert.equal(params.mapping, undefined);
  assert.equal(params.sourceMapping, "mojang");
});

test("validateParsedMixin explain=true keeps get-class-source context fields when that schema supports them", () => {
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

  // Pass partial context — only scope
  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, true,
    undefined, undefined,
    { scope: "vanilla", projectPath: "/my/project", mapping: "mojang", sourcePriority: "maven-first" }
  );
  const params = result.issues[0].suggestedCall!.params;
  assert.equal(params.scope, "vanilla");
  assert.equal(params.sourcePriority, "maven-first");
  assert.equal(params.projectPath, "/my/project");
  assert.equal(params.mapping, "mojang");
});

/* ------------------------------------------------------------------ */
/*  P6: warning aggregation mode                                       */
/* ------------------------------------------------------------------ */

test("validateParsedMixin warningMode=aggregated groups warnings by category", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [
    "Could not remap method \"a\" to mojang.",
    "Could not remap method \"b\" to mojang.",
    "Could not remap method \"c\" to mojang.",
    "Could not remap field \"d\" to mojang.",
    "Could not remap field \"e\" to mojang.",
    "Could not remap field \"f\" to mojang.",
    "Could not remap field \"g\" to mojang.",
    "Could not remap field \"h\" to mojang.",
    "Could not remap field \"i\" to mojang.",
    "Could not remap field \"j\" to mojang.",
    "Overriding version with project version from gradle.properties."
  ];

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, "aggregated"
  );

  // warnings and structuredWarnings should be omitted in aggregated mode
  assert.equal(result.warnings.length, 0);
  assert.equal(result.structuredWarnings, undefined);

  // aggregatedWarnings should be present
  assert.ok(result.aggregatedWarnings);
  assert.ok(result.aggregatedWarnings!.length >= 1);

  const mappingGroup = result.aggregatedWarnings!.find((g) => g.category === "mapping");
  assert.ok(mappingGroup);
  assert.equal(mappingGroup!.count, 10);
  assert.ok(mappingGroup!.samples.length <= 2);

  const configGroup = result.aggregatedWarnings!.find((g) => g.category === "configuration");
  assert.ok(configGroup);
  assert.equal(configGroup!.count, 1);
});

test("validateParsedMixin warningMode=full preserves all warnings (default)", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [
    "Could not remap method \"a\" to mojang.",
    "Some info message."
  ];

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, "full"
  );

  assert.equal(result.warnings.length, 2);
  assert.ok(result.structuredWarnings);
  assert.equal(result.aggregatedWarnings, undefined);
});

/* ------------------------------------------------------------------ */
/*  P1: toolHealth report                                              */
/* ------------------------------------------------------------------ */

function makeHealthReport(overrides: Partial<MappingHealthReport> = {}): MappingHealthReport {
  return {
    jarAvailable: true,
    jarPath: "/fake/jar.jar",
    mojangMappingsAvailable: true,
    tinyMappingsAvailable: true,
    memberRemapAvailable: true,
    overallHealthy: true,
    degradations: [],
    ...overrides
  };
}

test("P1: toolHealth is included in result when healthReport provided", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.ok(result.toolHealth);
  assert.equal(result.toolHealth!.jarAvailable, true);
  assert.equal(result.toolHealth!.overallHealthy, true);
  assert.deepEqual(result.toolHealth!.degradations, []);
});

test("P1: toolHealth absent when healthReport not provided", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);

  assert.equal(result.toolHealth, undefined);
  assert.equal(result.confidenceScore, undefined);
});

/* ------------------------------------------------------------------ */
/*  P2: severity downgrade when infrastructure degraded                */
/* ------------------------------------------------------------------ */

test("P2: target-not-found via signatureFailedTargets downgrades to warning when unhealthy", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const signatureFailedTargets = new Set(["PlayerEntity"]);
  const warnings: string[] = [];
  const health = makeHealthReport({ overallHealthy: false, degradations: ["Mojang mappings unavailable"] });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, signatureFailedTargets, undefined, undefined, health
  );

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].kind, "validation-incomplete");
  assert.equal(result.issues[0].confidence, "uncertain");
  assert.ok(result.issues[0].message.includes("could not load enough target metadata"));
  assert.equal(result.issues[0].falsePositiveRisk, "high");
  assert.equal(result.valid, true); // No definite errors
});

test("P2: target-not-found stays error when healthy", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const signatureFailedTargets = new Set(["PlayerEntity"]);
  const warnings: string[] = [];
  const health = makeHealthReport({ overallHealthy: true });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, "definite", undefined, false,
    undefined, signatureFailedTargets, undefined, undefined, health
  );

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].kind, "validation-incomplete");
  assert.equal(result.issues[0].confidence, "uncertain");
});

test("P2: method-not-found downgrades to warning when memberRemapAvailable=false and remap failed", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "unknownMethod", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "hurt"] })]
  ]);
  const remapFailedMembers = new Map([["PlayerEntity", new Set(["unknownMethod"])]]);
  const warnings: string[] = [];
  const health = makeHealthReport({ memberRemapAvailable: false, overallHealthy: true });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, "definite", undefined, false,
    remapFailedMembers, undefined, undefined, undefined, health
  );

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.ok(result.issues[0].message.includes("infrastructure degraded"));
  assert.equal(result.valid, true);
});

test("P2: field-not-found shadow downgrades to warning when memberRemapAvailable=false", () => {
  const parsed = makeParsedMixin({
    shadows: [{ name: "missingShadow", kind: "field", line: 20 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "level"] })]
  ]);
  const remapFailedMembers = new Map([["PlayerEntity", new Set(["missingShadow"])]]);
  const warnings: string[] = [];
  const health = makeHealthReport({ memberRemapAvailable: false, overallHealthy: true });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, "definite", undefined, false,
    remapFailedMembers, undefined, undefined, undefined, health
  );

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].kind, "field-not-found");
  assert.ok(result.issues[0].message.includes("infrastructure degraded"));
});

/* ------------------------------------------------------------------ */
/*  P6: confidenceScore                                                */
/* ------------------------------------------------------------------ */

test("P6: confidenceScore is 100 when fully healthy", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.equal(result.confidenceScore, 100);
});

test("P6: confidenceScore decreases when overallHealthy=false", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const health = makeHealthReport({
    overallHealthy: false,
    tinyMappingsAvailable: false,
    memberRemapAvailable: false
  });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  // base=100 -30 (unhealthy) -20 (no tiny) -15 (no member remap) = 35
  assert.equal(result.confidenceScore, 35);
});

test("P6: confidenceScore accounts for scopeFallback and mapping mismatch", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    scopeFallback: { requested: "merged", applied: "vanilla", reason: "test" }
  };
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  // base=100 -10 (scopeFallback) -15 (mapping mismatch) = 75
  assert.equal(result.confidenceScore, 75);
});

test("P6: confidenceScore accounts for remapFailures in provenance", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    remapFailures: 5
  };
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  // base=100 -10 (5 remap failures * 2) = 90
  assert.equal(result.confidenceScore, 90);
});

test("P6: confidenceScore clamps at 0", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    remapFailures: 20,
    scopeFallback: { requested: "merged", applied: "vanilla", reason: "test" }
  };
  const warnings: string[] = [];
  const health = makeHealthReport({
    overallHealthy: false,
    tinyMappingsAvailable: false,
    memberRemapAvailable: false
  });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  // base=100 -30 -20 -15 -10 -15 -20(capped) = -10 → clamped to 0
  assert.equal(result.confidenceScore, 0);
});

/* ------------------------------------------------------------------ */
/*  P7: falsePositiveRisk per issue                                    */
/* ------------------------------------------------------------------ */

test("P7: falsePositiveRisk is high for member-remap-failed when unhealthy", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "unknownMethod", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const remapFailedMembers = new Map([["PlayerEntity", new Set(["unknownMethod"])]]);
  const warnings: string[] = [];
  const health = makeHealthReport({ overallHealthy: false });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, "definite", undefined, false,
    remapFailedMembers, undefined, undefined, undefined, health
  );

  assert.equal(result.issues[0].falsePositiveRisk, "high");
});

test("P7: falsePositiveRisk is medium for target-mapping-failed", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailedTargets = new Set(["PlayerEntity"]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, mappingFailedTargets, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.equal(result.issues[0].kind, "target-mapping-failed");
  assert.equal(result.issues[0].falsePositiveRisk, "medium");
});

test("P7: falsePositiveRisk is high for target-mapping-failed when unhealthy", () => {
  const parsed = makeParsedMixin();
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailedTargets = new Set(["PlayerEntity"]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };
  const warnings: string[] = [];
  const health = makeHealthReport({ overallHealthy: false });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, mappingFailedTargets, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.equal(result.issues[0].kind, "target-mapping-failed");
  assert.equal(result.issues[0].falsePositiveRisk, "high");
});

test("P7: falsePositiveRisk is undefined when healthy and no remap issues", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "missingMethod", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.equal(result.issues[0].falsePositiveRisk, undefined);
});

test("P7: accessor falsePositiveRisk high when memberRemapAvailable=false and remap failed", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 15 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["level"] })]
  ]);
  const remapFailedMembers = new Map([["PlayerEntity", new Set(["health"])]]);
  const warnings: string[] = [];
  const health = makeHealthReport({ memberRemapAvailable: false });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, "definite", undefined, false,
    remapFailedMembers, undefined, undefined, undefined, health
  );

  assert.equal(result.issues[0].kind, "field-not-found");
  assert.equal(result.issues[0].falsePositiveRisk, "high");
});

/* ------------------------------------------------------------------ */
/*  Phase 1A: symbolExistsButSignatureFailed fallback                  */
/* ------------------------------------------------------------------ */

test("symbolExistsButSignatureFailed produces tool_issue warning and skipped members", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }],
    shadows: [{ kind: "field", name: "health", line: 8 }],
    accessors: [{ annotation: "Accessor", name: "getSpeed", targetName: "speed", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];
  const symbolExistsSet = new Set(["PlayerEntity"]);

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, symbolExistsSet
  );

  // Should be valid (warning only, not error)
  assert.equal(result.valid, true);
  assert.equal(result.validationStatus, "partial");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].kind, "validation-incomplete");
  assert.equal(result.issues[0].issueOrigin, "tool_issue");
  assert.equal(result.issues[0].falsePositiveRisk, "high");
  assert.ok(result.issues[0].message.includes("exists in mapping data"));
  assert.equal(result.summary.membersValidated, 0);
  assert.equal(result.summary.membersSkipped, 3);
  assert.equal(result.summary.membersMissing, 0);
  assert.ok(result.quickSummary?.includes("3 member(s) skipped"));

  // All members should be skipped
  assert.ok(result.resolvedMembers);
  assert.equal(result.resolvedMembers!.length, 3);
  for (const rm of result.resolvedMembers!) {
    assert.equal(rm.status, "skipped");
  }
});

test("symbolExistsButSignatureFailed does not block normal signature-resolved targets", () => {
  const parsed = makeParsedMixin({
    targets: [{ className: "PlayerEntity" }, { className: "LivingEntity" }],
    injections: [{ annotation: "Inject", method: "tick", line: 5 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];
  const symbolExistsSet = new Set(["LivingEntity"]);

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, symbolExistsSet
  );

  assert.equal(result.valid, true);
  assert.equal(result.validationStatus, "partial");
  // 1 warning for LivingEntity, 0 errors
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].target, "LivingEntity");
  assert.equal(result.issues[0].severity, "warning");
});

/* ------------------------------------------------------------------ */
/*  Phase 2A: issueOrigin classification                               */
/* ------------------------------------------------------------------ */

test("issueOrigin is code_issue for genuine target-class-missing", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "NonExistentClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].issueOrigin, "code_issue");
});

test("issueOrigin is tool_issue for target-mapping-failed", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "SomeClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const mappingFailed = new Set(["SomeClass"]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, undefined, mappingFailed);
  assert.equal(result.issues[0].issueOrigin, "tool_issue");
});

test("issueOrigin is tool_issue for member-remap-failed", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "healht", line: 8 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
  ]);
  const remapFailed = new Map([["PlayerEntity", new Set(["healht"])]]);
  const warnings: string[] = [];

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, undefined, undefined, undefined, false,
    remapFailed
  );
  assert.equal(result.issues[0].issueOrigin, "tool_issue");
});

/* ------------------------------------------------------------------ */
/*  Phase 2C: quickSummary                                             */
/* ------------------------------------------------------------------ */

test("quickSummary reports all members validated when no issues", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }],
    shadows: [{ kind: "field", name: "health", line: 8 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"], fields: ["health"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.validationStatus, "full");
  assert.equal(result.summary.membersValidated, 2);
  assert.equal(result.summary.membersSkipped, 0);
  assert.equal(result.summary.membersMissing, 0);
  assert.ok(result.quickSummary);
  assert.ok(result.quickSummary!.includes("2 member(s) validated successfully"));
  assert.ok(!result.quickSummary!.includes("skipped"));
});

test("quickSummary reports error counts when issues exist", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "nonExistent", line: 5 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.validationStatus, "invalid");
  assert.equal(result.summary.membersValidated, 0);
  assert.equal(result.summary.membersSkipped, 0);
  assert.equal(result.summary.membersMissing, 1);
  assert.ok(result.quickSummary);
  assert.ok(result.quickSummary!.includes("error(s)"));
  assert.ok(result.quickSummary!.includes("1 member(s) missing"));
});

test("P6: confidenceBreakdown captures base score and applied penalties", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.1",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "obfuscated",
    remapFailures: 5,
    scopeFallback: { requested: "merged", applied: "vanilla", reason: "test" }
  };
  const warnings: string[] = [];
  const health = makeHealthReport({
    overallHealthy: false,
    tinyMappingsAvailable: false,
    memberRemapAvailable: false
  });

  const result = validateParsedMixin(
    parsed, targetMembers, warnings, provenance, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );

  assert.equal(result.confidenceScore, 0);
  assert.equal(result.confidenceBreakdown?.baseScore, 100);
  assert.equal(result.confidenceBreakdown?.score, result.confidenceScore);
  assert.deepEqual(
    result.confidenceBreakdown?.penalties.map((penalty) => penalty.reason),
    [
      "mapping-health",
      "tiny-mappings-unavailable",
      "member-remap-unavailable",
      "scope-fallback",
      "mapping-mismatch",
      "remap-failures"
    ]
  );
});

/* ------------------------------------------------------------------ */
/*  Phase 2D: improved error messages                                  */
/* ------------------------------------------------------------------ */

test("@Shadow field-not-found message includes available field count", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "field", name: "missingField", line: 8 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger", "xp"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.issues[0].message.includes("3 field(s) available"));
});

test("@Shadow method-not-found message includes available method count", () => {
  const parsed = makeParsedMixin({
    shadows: [{ kind: "method", name: "missingMethod", line: 10 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.issues[0].message.includes("2 method(s) available"));
});

/* ------------------------------------------------------------------ */
/*  structuredWarnings: parse category classification                    */
/* ------------------------------------------------------------------ */

test("validateParsedMixin classifies 'missing method attribute' warning as parse category", () => {
  const parsed = makeParsedMixin({
    parseWarnings: ["Line 3: @Inject missing method attribute."]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", {})]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.structuredWarnings);
  const parseSw = result.structuredWarnings!.find((sw) => sw.category === "parse");
  assert.ok(parseSw);
  assert.equal(parseSw!.severity, "warning");
});

test("@Accessor error includes inference hint with prefix removal", () => {
  const parsed = makeParsedMixin({
    accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["hunger"] })]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.ok(result.issues[0].message.includes("inferred"));
  assert.ok(result.issues[0].message.includes("prefix removal"));
});
