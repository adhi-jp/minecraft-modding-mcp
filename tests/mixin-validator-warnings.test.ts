import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedMixin } from "../src/mixin-parser.ts";
import {
  validateParsedMixin,
  type ResolvedTargetMembers,
  type MixinValidationProvenance
} from "../src/mixin-validator.ts";
import {
  makeMember,
  makeTargetMembers,
  makeParsedMixin,
  makeProvenance,
  type ValidationResult,
  type ValidationIssue
} from "./helpers/mixin-validator-fixtures.ts";

test("validateParsedMixin explain mode adds representative guidance and suggested calls", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    provenance?: MixinValidationProvenance;
    explain?: boolean;
    verify: (issue: ValidationIssue, result: ValidationResult) => void;
  }> = [
    {
      name: "target-not-found adds class lookup guidance",
      parsed: makeParsedMixin({ targets: [{ className: "MissingClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      provenance: makeProvenance(),
      verify: (issue) => {
        assert.equal(issue.kind, "target-not-found");
        assert.ok(issue.explanation);
        assert.ok(issue.suggestedCall);
        assert.equal(issue.suggestedCall!.tool, "check-symbol-exists");
        assert.equal(issue.suggestedCall!.params.kind, "class");
        assert.equal(issue.suggestedCall!.params.name, "MissingClass");
        assert.equal(issue.suggestedCall!.params.version, "1.21");
        assert.equal(issue.suggestedCall!.params.sourceMapping, "mojang");
        assert.equal(issue.suggestedCall!.params.nameMode, "auto");
      }
    },
    {
      name: "method-not-found adds class source lookup guidance",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "missing", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      provenance: makeProvenance(),
      verify: (issue) => {
        assert.equal(issue.kind, "method-not-found");
        assert.ok(issue.explanation);
        assert.ok(issue.suggestedCall);
        assert.equal(issue.suggestedCall!.tool, "get-class-source");
        assert.equal(issue.suggestedCall!.params.mode, "metadata");
        assert.deepEqual(issue.suggestedCall!.params.target, {
          kind: "version",
          value: "1.21"
        });
        assert.equal(issue.suggestedCall!.params.targetKind, undefined);
        assert.equal(issue.suggestedCall!.params.targetValue, undefined);
        assert.equal(issue.suggestedCall!.params.version, undefined);
      }
    },
    {
      name: "field-not-found omits signatureMode",
      parsed: makeParsedMixin({
        shadows: [{ kind: "field", name: "missingField", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
      ]),
      provenance: makeProvenance(),
      verify: (issue) => {
        assert.equal(issue.kind, "field-not-found");
        assert.ok(issue.explanation);
        assert.ok(issue.suggestedCall);
        assert.equal(issue.suggestedCall!.tool, "check-symbol-exists");
        assert.equal(issue.suggestedCall!.params.kind, "field");
        assert.equal(issue.suggestedCall!.params.signatureMode, undefined);
        assert.equal(issue.suggestedCall!.params.version, "1.21");
        assert.equal(issue.suggestedCall!.params.sourceMapping, "mojang");
      }
    },
    {
      name: "missing provenance omits suggestedCall",
      parsed: makeParsedMixin({ targets: [{ className: "MissingClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      explain: true,
      verify: (issue) => {
        assert.equal(issue.kind, "target-not-found");
        assert.ok(issue.explanation);
        assert.equal(issue.suggestedCall, undefined);
      }
    },
    {
      name: "explain=false omits explanation and suggestedCall",
      parsed: makeParsedMixin({ targets: [{ className: "MissingClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      explain: false,
      verify: (issue) => {
        assert.equal(issue.kind, "target-not-found");
        assert.equal(issue.explanation, undefined);
        assert.equal(issue.suggestedCall, undefined);
      }
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
      testCase.explain ?? true
    );

    assert.equal(result.issues.length, 1, testCase.name);
    testCase.verify(result.issues[0], result);
  }
});

test("validateParsedMixin explain mode filters suggestedCall context by target tool schema", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    provenance: MixinValidationProvenance;
    validationContext: {
      scope?: string;
      sourcePriority?: string;
      projectPath?: string;
      mapping?: string;
    };
    verify: (issue: ValidationIssue) => void;
  }> = [
    {
      name: "check-symbol-exists drops unsupported context fields",
      parsed: makeParsedMixin({ targets: [{ className: "MissingClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      provenance: makeProvenance(),
      validationContext: {
        scope: "merged",
        sourcePriority: "loom-first",
        projectPath: "/my/project",
        mapping: "mojang"
      },
      verify: (issue) => {
        assert.equal(issue.suggestedCall!.tool, "check-symbol-exists");
        const params = issue.suggestedCall!.params;
        assert.equal(params.sourcePriority, "loom-first");
        assert.equal(params.scope, undefined);
        assert.equal(params.projectPath, undefined);
        assert.equal(params.mapping, undefined);
        assert.equal(params.sourceMapping, "mojang");
      }
    },
    {
      name: "get-class-source keeps supported context fields",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "missing", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      provenance: makeProvenance(),
      validationContext: {
        scope: "vanilla",
        sourcePriority: "maven-first",
        projectPath: "/my/project",
        mapping: "mojang"
      },
      verify: (issue) => {
        assert.equal(issue.suggestedCall!.tool, "get-class-source");
        const params = issue.suggestedCall!.params;
        assert.equal(params.scope, "vanilla");
        assert.equal(params.sourcePriority, "maven-first");
        assert.equal(params.projectPath, "/my/project");
        assert.equal(params.mapping, "mojang");
      }
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
      true,
      undefined,
      undefined,
      testCase.validationContext
    );

    assert.equal(result.issues.length, 1, testCase.name);
    assert.ok(result.issues[0].suggestedCall, testCase.name);
    testCase.verify(result.issues[0]);
  }
});

test("validateParsedMixin structuredWarnings classify representative warning categories", () => {
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

test("validateParsedMixin handles representative parse warning flows", async (t) => {
  const cases: Array<{
    name: string;
    run: () => void;
  }> = [
    {
      name: "escalates @Accessor parse warning to issue with parse category",
      run: () => {
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
      }
    },
    {
      name: "escalates @Invoker parse warning to issue with parse category",
      run: () => {
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
      }
    },
    {
      name: "escalates @Shadow parse warning to issue",
      run: () => {
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
      }
    },
    {
      name: "adds contradiction note when parse fails but same annotation resolves",
      run: () => {
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
        const parseIssue = result.issues.find((issue) => issue.category === "parse");
        assert.ok(parseIssue);
        assert.ok(
          parseIssue.message.includes("other members with the same annotation resolved successfully")
        );
      }
    },
    {
      name: "summary includes parseWarnings count",
      run: () => {
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
      }
    },
    {
      name: "keeps non-accessor/shadow parse warnings in warnings[]",
      run: () => {
        const parsed = makeParsedMixin({
          parseWarnings: ["Line 3: @Inject missing method attribute."]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", {})]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.equal(result.issues.length, 0);
        assert.ok(warnings.some((warning) => warning.includes("@Inject")));
        assert.equal(result.summary.parseWarnings, 0);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      testCase.run();
    });
  }
});

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
