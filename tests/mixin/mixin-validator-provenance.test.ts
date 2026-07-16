import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedMixin } from "../../src/mixin-parser.ts";
import {
  validateParsedMixin,
  type ResolvedTargetMembers,
  type MixinValidationProvenance,
  type IssueCategory,
  type ResolutionPath
} from "../../src/mixin-validator.ts";
import {
  makeMember,
  makeTargetMembers,
  makeParsedMixin,
  makeProvenance
} from "../helpers/mixin-validator-fixtures.ts";

test("validateParsedMixin handles representative confidence and remap-failed flows", async (t) => {
  const cases: Array<{
    name: string;
    run: () => void;
  }> = [
    {
      name: "with definite confidence marks issues as definite",
      run: () => {
        const parsed = makeParsedMixin({
          injections: [{ annotation: "Inject", method: "missing", line: 5 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          makeProvenance(),
          "definite"
        );
        assert.equal(result.valid, false);
        assert.equal(result.issues[0].confidence, "definite");
        assert.equal(result.summary.definiteErrors, 1);
        assert.equal(result.summary.uncertainErrors, 0);
      }
    },
    {
      name: "with uncertain confidence marks issues as uncertain",
      run: () => {
        const parsed = makeParsedMixin({
          injections: [{ annotation: "Inject", method: "missing", line: 5 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          makeProvenance({ requestedMapping: "yarn", mappingApplied: "obfuscated" }),
          "uncertain"
        );
        assert.equal(result.valid, true);
        assert.equal(result.issues[0].confidence, "uncertain");
        assert.ok(result.issues[0].confidenceReason?.includes("fallback"));
        assert.equal(result.summary.definiteErrors, 0);
        assert.equal(result.summary.uncertainErrors, 1);
      }
    },
    {
      name: "with likely confidence keeps issue definite-counted",
      run: () => {
        const parsed = makeParsedMixin({
          shadows: [{ kind: "field", name: "noSuchField", line: 8 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings, undefined, "likely");
        assert.equal(result.valid, false);
        assert.equal(result.issues[0].confidence, "likely");
        assert.equal(result.summary.definiteErrors, 1);
      }
    },
    {
      name: "without confidence arg defaults to no confidence on issues",
      run: () => {
        const parsed = makeParsedMixin({
          injections: [{ annotation: "Inject", method: "missing", line: 5 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.equal(result.issues[0].confidence, undefined);
        assert.equal(result.summary.definiteErrors, 1);
        assert.equal(result.summary.uncertainErrors, 0);
      }
    },
    {
      name: "downgrades confidence to uncertain for remap-failed members",
      run: () => {
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

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          "definite",
          undefined,
          false,
          remapFailedMembers
        );

        assert.equal(result.issues.length, 2);
        for (const issue of result.issues) {
          assert.equal(issue.confidence, "uncertain");
          assert.ok(issue.confidenceReason?.includes("remap artifact"));
          assert.equal(issue.resolutionPath, "member-remap-failed");
        }
        assert.equal(result.summary.uncertainErrors, 2);
        assert.equal(result.summary.definiteErrors, 0);
      }
    },
    {
      name: "keeps definite confidence for non-remap-failed members",
      run: () => {
        const parsed = makeParsedMixin({
          injections: [{ annotation: "Inject", method: "trulyMissing", line: 5 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];
        const remapFailedMembers = new Map<string, Set<string>>([
          ["PlayerEntity", new Set(["otherMethod"])]
        ]);

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          "definite",
          undefined,
          false,
          remapFailedMembers
        );
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].confidence, "definite");
        assert.equal(result.issues[0].resolutionPath, undefined);
      }
    },
    {
      name: "applies remap-failed downgrade per target only",
      run: () => {
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

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          "definite",
          undefined,
          false,
          remapFailedMembers
        );
        assert.equal(result.issues.length, 2);

        const playerIssue = result.issues.find((issue) => issue.target.startsWith("PlayerEntity#"));
        const mobIssue = result.issues.find((issue) => issue.target.startsWith("MobEntity#"));

        assert.equal(playerIssue?.confidence, "uncertain");
        assert.equal(playerIssue?.resolutionPath, "member-remap-failed");
        assert.equal(mobIssue?.confidence, "definite");
        assert.equal(mobIssue?.resolutionPath, undefined);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      testCase.run();
    });
  }
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

test("validateParsedMixin assigns representative resolution paths", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    mappingFailedTargets?: Set<string>;
    remapFailedMembers?: Map<string, Set<string>>;
    signatureFailedTargets?: Set<string>;
    confidence?: "definite" | "uncertain" | "likely";
    expectedResolutionPath: ResolutionPath;
    expectedCategory?: IssueCategory;
    expectedConfidence?: "definite" | "uncertain" | "likely";
  }> = [
    {
      name: "true not-found uses target-class-missing",
      parsed: makeParsedMixin({ targets: [{ className: "MissingClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      expectedResolutionPath: "target-class-missing"
    },
    {
      name: "mapping failures use target-mapping-failed",
      parsed: makeParsedMixin({ targets: [{ className: "MappedClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      mappingFailedTargets: new Set(["MappedClass"]),
      expectedResolutionPath: "target-mapping-failed"
    },
    {
      name: "signature failures use source-signature-unavailable",
      parsed: makeParsedMixin({ targets: [{ className: "SigFailClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      signatureFailedTargets: new Set(["SigFailClass"]),
      expectedResolutionPath: "source-signature-unavailable",
      expectedCategory: "resolution"
    },
    {
      name: "remap failures use member-remap-failed and downgrade confidence",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Invoker", name: "invokeObf", targetName: "obfMethod", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      remapFailedMembers: new Map<string, Set<string>>([
        ["PlayerEntity", new Set(["obfMethod"])]
      ]),
      confidence: "definite",
      expectedResolutionPath: "member-remap-failed",
      expectedConfidence: "uncertain"
    }
  ];

  for (const testCase of cases) {
    const result = validateParsedMixin(
      testCase.parsed,
      testCase.targetMembers,
      [],
      undefined,
      testCase.confidence,
      testCase.mappingFailedTargets,
      false,
      testCase.remapFailedMembers,
      testCase.signatureFailedTargets
    );

    assert.equal(result.issues.length, 1, testCase.name);
    const issue = result.issues[0];
    assert.equal(issue.resolutionPath, testCase.expectedResolutionPath, testCase.name);

    if (testCase.expectedCategory !== undefined) {
      assert.equal(issue.category, testCase.expectedCategory, testCase.name);
    }
    if (testCase.expectedConfidence !== undefined) {
      assert.equal(issue.confidence, testCase.expectedConfidence, testCase.name);
    }
  }
});

test("validateParsedMixin categorizes mapping, resolution, and validation issues", () => {
  const cases: Array<{
    name: string;
    parsed: ParsedMixin;
    targetMembers: Map<string, ResolvedTargetMembers>;
    mappingFailedTargets?: Set<string>;
    remapFailedMembers?: Map<string, Set<string>>;
    confidence?: "definite" | "uncertain" | "likely";
    expectedCategory: IssueCategory;
    expectedResolutionPath?: ResolutionPath;
    expectedResolutionErrors?: number;
  }> = [
    {
      name: "mapping failures stay in mapping category",
      parsed: makeParsedMixin({ targets: [{ className: "SomeClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      mappingFailedTargets: new Set(["SomeClass"]),
      expectedCategory: "mapping",
      expectedResolutionPath: "target-mapping-failed"
    },
    {
      name: "remap failures count as resolution errors",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "obfName", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      remapFailedMembers: new Map<string, Set<string>>([
        ["PlayerEntity", new Set(["obfName"])]
      ]),
      confidence: "definite",
      expectedCategory: "resolution",
      expectedResolutionPath: "member-remap-failed",
      expectedResolutionErrors: 1
    },
    {
      name: "real missing members stay in validation category",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "missing", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
      ]),
      expectedCategory: "validation",
      expectedResolutionPath: undefined,
      expectedResolutionErrors: 0
    }
  ];

  for (const testCase of cases) {
    const result = validateParsedMixin(
      testCase.parsed,
      testCase.targetMembers,
      [],
      undefined,
      testCase.confidence,
      testCase.mappingFailedTargets,
      false,
      testCase.remapFailedMembers
    );

    assert.equal(result.issues.length, 1, testCase.name);
    const issue = result.issues[0];
    assert.equal(issue.category, testCase.expectedCategory, testCase.name);
    assert.equal(issue.resolutionPath, testCase.expectedResolutionPath, testCase.name);

    if (testCase.expectedResolutionErrors !== undefined) {
      assert.equal(result.summary.resolutionErrors, testCase.expectedResolutionErrors, testCase.name);
    }
  }
});
