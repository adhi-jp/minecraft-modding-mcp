import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedMixin } from "../../src/mixin-parser.ts";
import {
  validateParsedMixin,
  type ResolvedTargetMembers,
  type MixinValidationProvenance,
  type MappingHealthReport
} from "../../src/mixin-validator.ts";
import {
  makeMember,
  makeTargetMembers,
  makeParsedMixin,
  makeProvenance,
  type ValidationResult
} from "../helpers/mixin-validator-fixtures.ts";

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

test("P6: confidenceScore reflects representative health and provenance penalties", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    provenance?: MixinValidationProvenance;
    health: MappingHealthReport;
    expectedScore: number;
  }> = [
    {
      name: "fully healthy validation stays at 100",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      health: makeHealthReport(),
      expectedScore: 100
    },
    {
      name: "unhealthy mapping stack applies cumulative health penalties",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      health: makeHealthReport({
        overallHealthy: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false
      }),
      expectedScore: 35
    },
    {
      name: "scope fallback and mapping mismatch reduce the score",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      provenance: makeProvenance({
        version: "1.21.1",
        mappingApplied: "obfuscated",
        scopeFallback: { requested: "merged", applied: "vanilla", reason: "test" }
      }),
      health: makeHealthReport(),
      expectedScore: 75
    },
    {
      name: "remap failures in provenance reduce the score",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      provenance: makeProvenance({
        version: "1.21.1",
        remapFailures: 5
      }),
      health: makeHealthReport(),
      expectedScore: 90
    },
    {
      name: "penalties clamp the score at zero",
      parsed: makeParsedMixin(),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      provenance: makeProvenance({
        version: "1.21.1",
        mappingApplied: "obfuscated",
        remapFailures: 20,
        scopeFallback: { requested: "merged", applied: "vanilla", reason: "test" }
      }),
      health: makeHealthReport({
        overallHealthy: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false
      }),
      expectedScore: 0
    }
  ];

  for (const testCase of cases) {
    const result = validateParsedMixin(
      testCase.parsed,
      testCase.targetMembers,
      [],
      testCase.provenance,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      testCase.health
    );

    assert.equal(result.confidenceScore, testCase.expectedScore, testCase.name);
  }
});

test("P7: falsePositiveRisk reflects representative resolution and health states", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    provenance?: MixinValidationProvenance;
    mappingFailedTargets?: Set<string>;
    remapFailedMembers?: Map<string, Set<string>>;
    confidence?: "definite" | "uncertain" | "likely";
    health: MappingHealthReport;
    expectedKind?: string;
    expectedRisk: "high" | "medium" | "low" | undefined;
  }> = [
    {
      name: "member-remap-failed is high risk when unhealthy",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "unknownMethod", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      remapFailedMembers: new Map([["PlayerEntity", new Set(["unknownMethod"])]]),
      confidence: "definite",
      health: makeHealthReport({ overallHealthy: false }),
      expectedRisk: "high"
    },
    {
      name: "target-mapping-failed is medium risk when otherwise healthy",
      parsed: makeParsedMixin(),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      provenance: makeProvenance({ version: "1.21.1" }),
      mappingFailedTargets: new Set(["PlayerEntity"]),
      health: makeHealthReport(),
      expectedKind: "target-mapping-failed",
      expectedRisk: "medium"
    },
    {
      name: "target-mapping-failed becomes high risk when unhealthy",
      parsed: makeParsedMixin(),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      provenance: makeProvenance({ version: "1.21.1" }),
      mappingFailedTargets: new Set(["PlayerEntity"]),
      health: makeHealthReport({ overallHealthy: false }),
      expectedKind: "target-mapping-failed",
      expectedRisk: "high"
    },
    {
      name: "healthy validation misses keep falsePositiveRisk undefined",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "missingMethod", line: 10 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      health: makeHealthReport(),
      expectedRisk: undefined
    },
    {
      name: "accessor misses become high risk when member remap is unavailable",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 15 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["level"] })]
      ]),
      remapFailedMembers: new Map([["PlayerEntity", new Set(["health"])]]),
      confidence: "definite",
      health: makeHealthReport({ memberRemapAvailable: false }),
      expectedKind: "field-not-found",
      expectedRisk: "high"
    }
  ];

  for (const testCase of cases) {
    const result = validateParsedMixin(
      testCase.parsed,
      testCase.targetMembers,
      [],
      testCase.provenance,
      testCase.confidence,
      testCase.mappingFailedTargets,
      false,
      testCase.remapFailedMembers,
      undefined,
      undefined,
      undefined,
      testCase.health
    );

    assert.equal(result.issues.length, 1, testCase.name);
    const issue = result.issues[0];
    if (testCase.expectedKind !== undefined) {
      assert.equal(issue.kind, testCase.expectedKind, testCase.name);
    }
    assert.equal(issue.falsePositiveRisk, testCase.expectedRisk, testCase.name);
  }
});

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

test("issueOrigin is code_issue for genuine target-class-missing", () => {
  const parsed = makeParsedMixin({ targets: [{ className: "NonExistentClass" }] });
  const targetMembers = new Map<string, ResolvedTargetMembers>();
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.issues[0].issueOrigin, "code_issue");
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

test("quickSummary reports representative success and failure summaries", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    expectedStatus: ValidationResult["validationStatus"];
    expectedSummary: Partial<ValidationResult["summary"]>;
    includes: string[];
    excludes?: string[];
  }> = [
    {
      name: "successful validation reports validated member counts",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 5 }],
        shadows: [{ kind: "field", name: "health", line: 8 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"], fields: ["health"] })]
      ]),
      expectedStatus: "full",
      expectedSummary: {
        membersValidated: 2,
        membersMissing: 0,
        membersSkipped: 0,
        definiteErrors: 0,
        uncertainErrors: 0,
        resolutionErrors: 0
      },
      includes: ["2 member(s) validated successfully"],
      excludes: ["skipped"]
    },
    {
      name: "invalid validation reports missing member counts",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "nonExistent", line: 5 }]
      }),
      targetMembers: new Map([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      expectedStatus: "invalid",
      expectedSummary: {
        membersValidated: 0,
        membersMissing: 1,
        membersSkipped: 0,
        definiteErrors: 1,
        uncertainErrors: 0,
        resolutionErrors: 0
      },
      includes: ["error(s)", "1 member(s) missing"]
    }
  ];

  for (const testCase of cases) {
    const result = validateParsedMixin(testCase.parsed, testCase.targetMembers, []);
    assert.equal(result.validationStatus, testCase.expectedStatus, testCase.name);
    for (const [key, value] of Object.entries(testCase.expectedSummary)) {
      assert.deepEqual(result.summary[key as keyof ValidationResult["summary"]], value, `${testCase.name}: ${key}`);
    }
    assert.ok(result.quickSummary, testCase.name);

    for (const fragment of testCase.includes) {
      assert.ok(result.quickSummary!.includes(fragment), `${testCase.name}: ${fragment}`);
    }
    for (const fragment of testCase.excludes ?? []) {
      assert.ok(!result.quickSummary!.includes(fragment), `${testCase.name}: ${fragment}`);
    }
  }
});

test("quickSummary surfaces scopeFallback when provenance records a fallback", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.10",
    jarPath: "/fake/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    scopeFallback: {
      requested: "merged",
      applied: "vanilla",
      reason: "Loom cache unavailable"
    }
  };

  const result = validateParsedMixin(parsed, targetMembers, [], provenance);
  assert.ok(result.quickSummary);
  assert.match(result.quickSummary!, /Scope fell back from "merged" to "vanilla"/);
  assert.match(result.quickSummary!, /Loom cache unavailable/);
});

test("quickSummary surfaces mapping-health degradation when healthReport is unhealthy", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const health = makeHealthReport({
    overallHealthy: false,
    jarAvailable: false,
    degradations: ["Game jar not found.", "Mojang mappings unavailable"]
  });

  const result = validateParsedMixin(
    parsed, targetMembers, [], undefined, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );
  assert.ok(result.quickSummary);
  assert.match(result.quickSummary!, /Mapping health degraded/);
  assert.match(result.quickSummary!, /Game jar not found/);
});

test("quickSummary stays concise when provenance is clean and healthReport is healthy", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick", line: 5 }]
  });
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);
  const provenance: MixinValidationProvenance = {
    version: "1.21.10",
    jarPath: "/fake/client.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang"
  };
  const health = makeHealthReport();

  const result = validateParsedMixin(
    parsed, targetMembers, [], provenance, undefined, undefined, false,
    undefined, undefined, undefined, undefined, health
  );
  assert.ok(result.quickSummary);
  assert.doesNotMatch(result.quickSummary!, /Scope fell back/);
  assert.doesNotMatch(result.quickSummary!, /Mapping health degraded/);
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
