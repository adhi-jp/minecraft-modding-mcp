import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshMixinValidationOutcome,
  loadMixinStageBudgets,
  type MixinValidationResult,
  type ValidationSummary
} from "../src/mixin-validator.ts";
import { validateMixinSchema } from "../src/tool-schemas.ts";

function makeBaseSummary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    injections: 0,
    shadows: 0,
    accessors: 0,
    total: 0,
    membersValidated: 0,
    membersSkipped: 0,
    membersMissing: 0,
    errors: 0,
    warnings: 0,
    definiteErrors: 0,
    uncertainErrors: 0,
    resolutionErrors: 0,
    parseWarnings: 0,
    ...overrides
  };
}

function makeBaseResult(summaryOverrides: Partial<ValidationSummary> = {}): MixinValidationResult {
  return {
    className: "TestMixin",
    targets: ["PlayerEntity"],
    valid: true,
    validationStatus: "full",
    issues: [],
    summary: makeBaseSummary(summaryOverrides),
    warnings: []
  };
}

test("computeValidationStatus: targetsDeferredBudget alone promotes to partial", () => {
  const result = makeBaseResult({ targetsDeferredBudget: 1 });
  refreshMixinValidationOutcome(result);
  assert.equal(result.validationStatus, "partial");
});

test("refreshMixinValidationOutcome preserves targetsDeferredBudget across recompute", () => {
  const result = makeBaseResult({ targetsDeferredBudget: 3 });
  refreshMixinValidationOutcome(result);
  assert.equal(result.summary.targetsDeferredBudget, 3);
  // Run refresh a second time — must not silently drop budget signal.
  refreshMixinValidationOutcome(result);
  assert.equal(result.summary.targetsDeferredBudget, 3);
  assert.equal(result.validationStatus, "partial");
});

test("computeValidationStatus: degradedReason='stage-budget-pre-target' alone is partial", () => {
  const result = makeBaseResult({ degradedReason: "stage-budget-pre-target" });
  refreshMixinValidationOutcome(result);
  assert.equal(result.validationStatus, "partial");
});

test("refresh keeps degradedReason='stage-budget-pre-target' (regression: refresh dropping it would yield 'full')", () => {
  const result = makeBaseResult({ degradedReason: "stage-budget-pre-target" });
  refreshMixinValidationOutcome(result);
  assert.equal(result.summary.degradedReason, "stage-budget-pre-target");
  assert.equal(result.validationStatus, "partial");
  refreshMixinValidationOutcome(result);
  assert.equal(result.summary.degradedReason, "stage-budget-pre-target");
  assert.equal(result.validationStatus, "partial");
});

test("buildQuickSummary surfaces 'deferred by stage budget' when targetsDeferredBudget > 0", () => {
  const result = makeBaseResult({ targetsDeferredBudget: 4, degradedReason: "stage-budget" });
  refreshMixinValidationOutcome(result);
  assert.ok(result.quickSummary);
  assert.ok(result.quickSummary!.includes("4 target(s) deferred by stage budget"));
});

test("buildQuickSummary surfaces 'Budget exhausted before any target processed' for pre-target", () => {
  const result = makeBaseResult({ degradedReason: "stage-budget-pre-target" });
  refreshMixinValidationOutcome(result);
  assert.ok(result.quickSummary);
  assert.ok(
    result.quickSummary!.includes("Budget exhausted before any target processed"),
    `quickSummary was: ${result.quickSummary}`
  );
});

test("loadMixinStageBudgets returns defaults when env not set", () => {
  delete process.env.MIXIN_STAGE_BUDGETS_OFF;
  const budgets = loadMixinStageBudgets();
  assert.equal(budgets.targetLookup, 60_000);
  assert.equal(budgets.perTarget, 8_000);
});

test("loadMixinStageBudgets honors MIXIN_STAGE_BUDGETS_OFF=1 → infinity", () => {
  process.env.MIXIN_STAGE_BUDGETS_OFF = "1";
  try {
    const budgets = loadMixinStageBudgets({ targetLookup: 1 });
    assert.equal(budgets.targetLookup, Number.POSITIVE_INFINITY);
    assert.equal(budgets.perTarget, Number.POSITIVE_INFINITY);
  } finally {
    delete process.env.MIXIN_STAGE_BUDGETS_OFF;
  }
});

test("loadMixinStageBudgets allows test-only override of individual stages", () => {
  delete process.env.MIXIN_STAGE_BUDGETS_OFF;
  const budgets = loadMixinStageBudgets({ targetLookup: 1, perTarget: 0 });
  assert.equal(budgets.targetLookup, 1);
  assert.equal(budgets.perTarget, 0);
  // unspecified stages keep defaults
  assert.equal(budgets.resolve, 15_000);
});

test("validateMixinSchema accepts every documented parameter value (reportMode, warningCategoryFilter, etc.)", () => {
  const base = {
    input: { mode: "inline", source: "class M {}" },
    version: "1.21.10"
  } as const;

  // reportMode default is "summary-first" (lean report by default)
  const defaults = validateMixinSchema.parse(base);
  assert.equal(defaults.reportMode, "summary-first");
  assert.equal(defaults.treatInfoAsWarning, true);
  assert.equal(defaults.preferProjectMapping, false);
  assert.equal(defaults.includeIssues, true);
  assert.equal(defaults.warningCategoryFilter, undefined);

  for (const reportMode of ["compact", "full", "summary-first"] as const) {
    const out = validateMixinSchema.parse({ ...base, reportMode });
    assert.equal(out.reportMode, reportMode);
  }

  for (const category of ["mapping", "configuration", "validation", "resolution", "parse"] as const) {
    const out = validateMixinSchema.parse({ ...base, warningCategoryFilter: [category] });
    assert.deepEqual(out.warningCategoryFilter, [category]);
  }

  const both = validateMixinSchema.parse({
    ...base,
    preferProjectMapping: true,
    treatInfoAsWarning: false,
    includeIssues: false
  });
  assert.equal(both.preferProjectMapping, true);
  assert.equal(both.treatInfoAsWarning, false);
  assert.equal(both.includeIssues, false);
});

test("validateMixinSchema rejects unknown reportMode and unknown warningCategoryFilter values", () => {
  const base = {
    input: { mode: "inline", source: "class M {}" },
    version: "1.21.10"
  } as const;
  const badReportMode = validateMixinSchema.safeParse({ ...base, reportMode: "verbose" as any });
  assert.equal(badReportMode.success, false);
  if (!badReportMode.success) {
    assert.ok(
      badReportMode.error.issues.some((issue) => issue.path.join(".") === "reportMode"),
      `expected rejection path to include "reportMode", got: ${JSON.stringify(badReportMode.error.issues.map((i) => i.path))}`
    );
  }
  const badCategory = validateMixinSchema.safeParse({
    ...base,
    warningCategoryFilter: ["unknown-cat" as any]
  });
  assert.equal(badCategory.success, false);
  if (!badCategory.success) {
    assert.ok(
      badCategory.error.issues.some((issue) =>
        issue.path.join(".").startsWith("warningCategoryFilter")
      ),
      `expected rejection path to include "warningCategoryFilter", got: ${JSON.stringify(badCategory.error.issues.map((i) => i.path))}`
    );
  }
});

test("validateMixinSchema config mode accepts an array of mixin config paths", () => {
  const parsed = validateMixinSchema.parse({
    input: { mode: "config", configPaths: ["src/main/resources/mod.mixins.json", "other.mixins.json"] },
    version: "1.21.10"
  });
  assert.equal(parsed.input.mode, "config");
  assert.deepEqual(
    (parsed.input as Extract<typeof parsed.input, { mode: "config" }>).configPaths,
    ["src/main/resources/mod.mixins.json", "other.mixins.json"]
  );
});

test("validateMixinSchema input modes are mutually exclusive (paths vs configPaths)", () => {
  // mode: "paths" requires `paths`; the test must verify the rejection is
  // about the missing `paths` field (the structural contract), not just any
  // failure. A regression that accepts both keys together would otherwise
  // sneak through, because Zod's discriminated union strips unknown keys
  // silently when the required field is also supplied.
  const pathsModeWithConfigPaths = validateMixinSchema.safeParse({
    input: { mode: "paths", configPaths: ["x"] } as any,
    version: "1.21.10"
  });
  assert.equal(pathsModeWithConfigPaths.success, false);
  if (!pathsModeWithConfigPaths.success) {
    assert.ok(
      pathsModeWithConfigPaths.error.issues.some(
        (issue) => issue.path.join(".") === "input.paths"
      ),
      `mode='paths' without 'paths' must fail on input.paths, got: ${JSON.stringify(pathsModeWithConfigPaths.error.issues)}`
    );
  }

  const configModeWithPaths = validateMixinSchema.safeParse({
    input: { mode: "config", paths: ["x"] } as any,
    version: "1.21.10"
  });
  assert.equal(configModeWithPaths.success, false);
  if (!configModeWithPaths.success) {
    assert.ok(
      configModeWithPaths.error.issues.some(
        (issue) => issue.path.join(".") === "input.configPaths"
      ),
      `mode='config' without 'configPaths' must fail on input.configPaths, got: ${JSON.stringify(configModeWithPaths.error.issues)}`
    );
  }
});

test("validateMixinSchema config mode requires a non-empty configPaths array", () => {
  assert.throws(() =>
    validateMixinSchema.parse({
      input: { mode: "config", configPaths: [] },
      version: "1.21.10"
    })
  );
});
