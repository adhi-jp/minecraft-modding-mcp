import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMultiTargetMixinSource(targetNames: string[]): string {
  const mixinList = targetNames
    .map((name) => `"net.minecraft.server.${name}"`)
    .join(", ");
  return [
    "import org.spongepowered.asm.mixin.Mixin;",
    "",
    `@Mixin(targets = {${mixinList}})`,
    "public abstract class GenericMixin {}"
  ].join("\n");
}

async function setupStubbedService(root: string): Promise<{
  service: unknown;
  sourcePath: string;
  jarPath: string;
}> {
  const { SourceService } = await import("../../src/source-service.ts");
  const sourcePath = join(root, "GenericMixin.java");
  const jarPath = join(root, "client.jar");

  const targetNames = Array.from({ length: 12 }, (_, i) => `Target${i}`);
  await writeFile(sourcePath, buildMultiTargetMixinSource(targetNames), "utf8");
  await createJar(jarPath, {});

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    async checkMappingHealth() {
      return {
        mojangMappingsAvailable: true,
        tinyMappingsAvailable: true,
        memberRemapAvailable: true,
        degradations: []
      };
    },
    async findMapping() {
      return {
        resolved: true,
        status: "resolved",
        resolvedSymbol: { name: "a" },
        candidates: []
      };
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        className: "a",
        constructors: [],
        methods: [],
        fields: [],
        warnings: []
      };
    }
  };
  return { service, sourcePath, jarPath };
}

test("validate-mixin: stage-total deferred-budget records ok + deferred + slowTarget", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-deferred-"));
  const { service, sourcePath } = await setupStubbedService(root);

  // 50ms total target-lookup budget, 5ms per-target soft cap.
  // Inject a 10ms sleep before each iteration → ~6 iterations fit before 50ms.
  const result = await (service as {
    validateMixin: (
      input: unknown,
      options: unknown
    ) => Promise<{ results: { result?: { targetOutcomes?: unknown[]; summary: Record<string, unknown>; validationStatus: string; quickSummary?: string } }[] }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang"
    },
    {
      __stageBudgets: { targetLookup: 50, perTarget: 5 },
      __testHooks: {
        beforeTargetIter: async () => {
          await sleep(10);
        }
      }
    }
  );

  const single = result.results[0]?.result;
  assert.ok(single, "expected a single mixin result");
  assert.equal(single.validationStatus, "partial");
  assert.equal(single.summary.degradedReason, "stage-budget");

  const outcomes = single.targetOutcomes as Array<{
    status: string;
    slowTarget?: boolean;
    targetClass: string;
    elapsedMs?: number;
  }>;
  assert.ok(outcomes.length > 0, "expected target outcomes recorded");
  const okEntries = outcomes.filter((o) => o.status === "ok");
  const deferredEntries = outcomes.filter((o) => o.status === "deferred-budget");
  assert.ok(okEntries.length >= 1, "expected at least one completed target");
  assert.ok(deferredEntries.length >= 1, "expected at least one deferred target");
  assert.equal(okEntries.length + deferredEntries.length, 12);

  assert.equal(single.summary.targetsDeferredBudget, deferredEntries.length);
  assert.ok(
    okEntries.every((o) => o.slowTarget === true),
    "expected each completed target to be flagged slowTarget at perTarget=5ms with 10ms sleep"
  );

  assert.ok(
    single.quickSummary?.includes(
      `${deferredEntries.length} target(s) deferred by stage budget`
    ),
    `quickSummary should mention deferred targets, got: ${single.quickSummary}`
  );
});

test("validate-mixin: pre-target boundary returns partial with empty targetOutcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-pre-target-"));
  const { service, sourcePath } = await setupStubbedService(root);

  const result = await (service as {
    validateMixin: (
      input: unknown,
      options: unknown
    ) => Promise<{ results: { result?: { targetOutcomes?: unknown[]; summary: Record<string, unknown>; validationStatus: string; quickSummary?: string } }[] }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang"
    },
    {
      __stageBudgets: { targetLookup: 1 },
      __testHooks: {
        beforeTargetLoop: async () => {
          await sleep(5);
        }
      }
    }
  );

  const single = result.results[0]?.result;
  assert.ok(single);
  assert.equal(single.validationStatus, "partial");
  assert.equal(single.summary.degradedReason, "stage-budget-pre-target");
  assert.equal(single.summary.targetsDeferredBudget, undefined);
  assert.deepEqual(single.targetOutcomes ?? [], []);
  assert.ok(
    single.quickSummary?.includes("Budget exhausted before any target processed"),
    `quickSummary should mention pre-target budget, got: ${single.quickSummary}`
  );
});

test("validate-mixin: input-validation budget exhaustion raises ERR_STAGE_BUDGET_PRE_PARSE before pipeline starts", async () => {
  // Guards the input-validation budget over sourcePath reads and version
  // normalization; without enforcement, slow input I/O could hang past the
  // documented soft-deadline.
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-input-budget-"));
  const sourcePath = join(root, "M.java");
  // Write a slow-readable file by writing a large blob and using a tiny
  // budget; any non-zero read latency exceeds 0ms.
  await writeFile(sourcePath, "@Mixin(targets=\"net.minecraft.X\")\nclass M {}\n", "utf8");

  const { SourceService } = await import("../../src/source-service.ts");
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      (service as { validateMixin: (input: unknown, options: unknown) => Promise<unknown> }).validateMixin(
        {
          input: { mode: "path", path: sourcePath },
          version: "1.21",
          mapping: "mojang"
        },
        {
          // Budget set to 0 so any positive elapsed exceeds it.
          __stageBudgets: { inputValidation: 0 }
        }
      ),
    (error: unknown) => {
      const e = error as {
        code?: string;
        details?: { failedStage?: string; stageBudgetExhausted?: boolean; budgetMs?: number };
      };
      return (
        e.code === ERROR_CODES.STAGE_BUDGET_PRE_PARSE &&
        e.details?.failedStage === "input-validation" &&
        e.details?.stageBudgetExhausted === true &&
        e.details?.budgetMs === 0
      );
    }
  );
});

test("validate-mixin: pre-parse mapping-health budget exhaustion throws ERR_STAGE_BUDGET_PRE_PARSE", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-pre-parse-"));
  const { service, sourcePath } = await setupStubbedService(root);

  await assert.rejects(
    () =>
      (service as {
        validateMixin: (input: unknown, options: unknown) => Promise<unknown>;
      }).validateMixin(
        {
          input: { mode: "path", path: sourcePath },
          version: "1.21",
          mapping: "mojang"
        },
        {
          __stageBudgets: { mappingHealth: 1 },
          __testHooks: {
            afterMappingHealth: async () => {
              await sleep(10);
            }
          }
        }
      ),
    (error: unknown) => {
      const e = error as { code?: string; details?: { failedStage?: string; stageBudgetExhausted?: boolean } };
      return (
        e.code === ERROR_CODES.STAGE_BUDGET_PRE_PARSE &&
        e.details?.failedStage === "mapping-health" &&
        e.details?.stageBudgetExhausted === true
      );
    }
  );
});

test("validate-mixin: cross-stage budget independence — slow resolve does not consume mapping-health budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-cross-stage-"));
  const { service, sourcePath } = await setupStubbedService(root);

  // Resolve sleeps 30ms (within resolve's 200ms budget). mapping-health budget
  // is 50ms and starts fresh — mapping-health should NOT be marked exhausted.
  const output = await (service as {
    validateMixin: (input: unknown, options: unknown) => Promise<{
      results: { result?: { validationStatus: string; targetOutcomes?: unknown[] } }[];
    }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang"
    },
    {
      __stageBudgets: {
        resolve: 200,
        mappingHealth: 50,
        parse: 50,
        targetLookup: 200,
        perTarget: 50
      },
      __testHooks: {
        afterResolve: async () => {
          await sleep(30);
        }
      }
    }
  );

  const single = output.results[0]?.result;
  assert.ok(single);
  // Should complete normally (no partial / no error throw).
  assert.notEqual(single.validationStatus, "invalid");
  // No deferral expected — pipeline succeeded.
  const outcomes = (single.targetOutcomes ?? []) as Array<{ status: string }>;
  assert.ok(
    outcomes.every((o) => o.status === "ok"),
    "no deferred-budget outcomes expected for cross-stage independence test"
  );
});

test("validate-mixin: MIXIN_STAGE_BUDGETS_OFF=1 disables all budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-off-"));
  const { service, sourcePath } = await setupStubbedService(root);

  process.env.MIXIN_STAGE_BUDGETS_OFF = "1";
  try {
    // With budgets off, even a tiny override is ignored — expected: 12 ok outcomes, no deferral.
    const output = await (service as {
      validateMixin: (input: unknown, options: unknown) => Promise<{
        results: { result?: { validationStatus: string; targetOutcomes?: unknown[]; summary: Record<string, unknown> } }[];
      }>;
    }).validateMixin(
      {
        input: { mode: "path", path: sourcePath },
        version: "1.21",
        mapping: "mojang"
      },
      {
        __stageBudgets: { targetLookup: 1, perTarget: 1 },
        __testHooks: {
          beforeTargetIter: async () => {
            await sleep(2);
          }
        }
      }
    );

    const single = output.results[0]?.result;
    assert.ok(single);
    const outcomes = (single.targetOutcomes ?? []) as Array<{ status: string; slowTarget?: boolean }>;
    assert.equal(outcomes.length, 12, "all 12 targets should complete");
    assert.ok(outcomes.every((o) => o.status === "ok"));
    assert.ok(outcomes.every((o) => o.slowTarget === undefined));
    assert.equal(single.summary.targetsDeferredBudget, undefined);
    assert.equal(single.summary.degradedReason, undefined);
  } finally {
    delete process.env.MIXIN_STAGE_BUDGETS_OFF;
  }
});

test("validate-mixin: signature-load failure produces targetOutcome with status='tool-issue' (not 'ok')", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-tool-issue-"));
  const { service, sourcePath } = await setupStubbedService(root);

  // Override explorerService.getSignature to throw so the catch path that
  // populates signatureFailedTargets / symbolExistsButSignatureFailed runs
  // and the per-target outcome must classify as `tool-issue`.
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      throw new Error("CLASS_NOT_FOUND in jar");
    }
  };
  // checkSymbolExists also throws so signatureFailedTargets fires (the
  // tool-limited fallback when even existence check fails).
  (service as unknown as { mappingService: { checkMappingHealth: unknown; findMapping: unknown; checkSymbolExists: unknown } }).mappingService = {
    async checkMappingHealth() {
      return { mojangMappingsAvailable: true, tinyMappingsAvailable: true, memberRemapAvailable: true, degradations: [] };
    },
    async findMapping() {
      return { resolved: true, status: "resolved", resolvedSymbol: { name: "a" }, candidates: [] };
    },
    async checkSymbolExists() {
      throw new Error("symbol existence check failed");
    }
  };

  const output = await (service as {
    validateMixin: (input: unknown, options: unknown) => Promise<{
      results: { result?: { targetOutcomes?: Array<{ status: string; reason?: string; targetClass: string }> } }[];
    }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang"
    },
    {}
  );

  const single = output.results[0]?.result;
  assert.ok(single);
  const outcomes = single.targetOutcomes ?? [];
  assert.equal(outcomes.length, 12, "every target should have produced an outcome");
  assert.ok(
    outcomes.every((o) => o.status === "tool-issue"),
    `expected all outcomes to be tool-issue when getSignature fails; got: ${JSON.stringify(outcomes.map((o) => o.status))}`
  );
  assert.ok(
    outcomes.every((o) => typeof o.reason === "string" && o.reason.length > 0),
    "tool-issue outcomes must include a reason"
  );
});

test("validate-mixin: whole member-remap failure produces tool-issue (not 'ok') target outcome", async () => {
  // The per-target tool-issue check covers per-member failures via
  // remapFailedMembers; this test forces the whole-batch remap catch (which
  // does not populate that map) to fire and asserts the target outcome still
  // reports `tool-issue`.
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-whole-remap-"));
  const { service, sourcePath } = await setupStubbedService(root);

  // Make explorerService.getSignature return at least one method so the
  // remap branch is taken.
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        className: "a",
        constructors: [],
        methods: [
          {
            name: "tick",
            javaSignature: "void tick()",
            jvmDescriptor: "()V",
            ownerFqn: "a",
            accessFlags: 1,
            isSynthetic: false
          }
        ],
        fields: [],
        warnings: []
      };
    }
  };
  // Force the remap pipeline to throw so the whole-batch catch fires.
  (service as unknown as { remapSignatureMembers: unknown }).remapSignatureMembers =
    async () => { throw new Error("simulated remap pipeline failure"); };

  const output = await (service as {
    validateMixin: (input: unknown, options: unknown) => Promise<{
      results: { result?: { targetOutcomes?: Array<{ status: string; reason?: string; targetClass: string }> } }[];
    }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang"
    },
    {}
  );

  const single = output.results[0]?.result;
  assert.ok(single);
  const outcomes = single.targetOutcomes ?? [];
  assert.ok(outcomes.length > 0);
  assert.ok(
    outcomes.every((o) => o.status === "tool-issue"),
    `whole-remap failure must produce tool-issue outcomes, got: ${JSON.stringify(outcomes.map((o) => o.status))}`
  );
  assert.ok(
    outcomes.every((o) => o.reason === "member-remap-failed-whole"),
    "tool-issue reason must indicate whole-remap failure"
  );
});

test("validate-mixin: budget partial does NOT trigger maven-first retry under loom-first default", async () => {
  // Budget-deferred targets feed `membersSkipped`, which would otherwise
  // trip `shouldRetryValidateMixinWithMavenFirst` and re-run the full
  // pipeline under maven-first — defeating the soft-deadline. Budget
  // partials must return promptly without retry.
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-budget-no-retry-"));
  const { service } = await setupStubbedService(root);
  // Use a mixin source carrying a member declaration so addSkippedMembers
  // populates resolvedMembers / membersSkipped on a budget-deferred target.
  const sourcePath = join(root, "MemberMixin.java");
  await writeFile(
    sourcePath,
    [
      "import org.spongepowered.asm.mixin.Mixin;",
      "import org.spongepowered.asm.mixin.injection.Inject;",
      "import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;",
      "@Mixin(targets = {",
      "  \"net.minecraft.server.A\", \"net.minecraft.server.B\", \"net.minecraft.server.C\",",
      "  \"net.minecraft.server.D\", \"net.minecraft.server.E\", \"net.minecraft.server.F\"",
      "})",
      "public abstract class MemberMixin {",
      "  @Inject(method = \"tick\", at = @At(\"HEAD\"))",
      "  private void onTick(CallbackInfo ci) {}",
      "}"
    ].join("\n"),
    "utf8"
  );

  let validateCallCount = 0;
  // Track sourcePriority over recursive retries via a peek into the underlying validateMixinSingle.
  const seenPriorities: string[] = [];
  const realValidateSingle = (
    service as unknown as { validateMixinSingle: (...args: unknown[]) => Promise<unknown> }
  ).validateMixinSingle.bind(service);
  (service as unknown as { validateMixinSingle: (...args: unknown[]) => Promise<unknown> }).validateMixinSingle =
    async (input: unknown) => {
      validateCallCount += 1;
      seenPriorities.push((input as { sourcePriority?: string }).sourcePriority ?? "loom-first");
      return realValidateSingle(input);
    };

  const result = await (service as {
    validateMixin: (input: unknown, options: unknown) => Promise<{
      results: { result?: { validationStatus: string; summary: Record<string, unknown> } }[];
    }>;
  }).validateMixin(
    {
      input: { mode: "path", path: sourcePath },
      version: "1.21",
      mapping: "mojang",
      sourcePriority: "loom-first"
    },
    {
      __stageBudgets: { targetLookup: 1 },
      __testHooks: {
        beforeTargetLoop: async () => {
          await sleep(5);
        }
      }
    }
  );

  const single = result.results[0]?.result;
  assert.ok(single);
  assert.equal(single.validationStatus, "partial");
  assert.equal(single.summary.degradedReason, "stage-budget-pre-target");
  // Single call only — no maven-first retry. Without the guard, the partial
  // result would have triggered a recursive validateMixinSingle call.
  assert.equal(validateCallCount, 1, "budget partial must not trigger recursive maven-first retry");
  assert.deepEqual(seenPriorities, ["loom-first"]);
});

test("validate-mixin: batch-mode preserves typed AppError code and details on per-entry errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-mixin-batch-typed-error-"));
  const { service, sourcePath } = await setupStubbedService(root);
  const sourcePathB = join(root, "GenericMixinB.java");
  await writeFile(
    sourcePathB,
    [
      "import org.spongepowered.asm.mixin.Mixin;",
      "@Mixin(targets = {\"net.minecraft.server.OnlyOne\"})",
      "public abstract class GenericMixinB {}"
    ].join("\n"),
    "utf8"
  );

  const output = await (service as {
    validateMixin: (input: unknown, options: unknown) => Promise<{
      results: Array<{
        error?: string;
        errorCode?: string;
        errorDetails?: Record<string, unknown>;
      }>;
    }>;
  }).validateMixin(
    {
      input: { mode: "paths", paths: [sourcePath, sourcePathB] },
      version: "1.21",
      mapping: "mojang"
    },
    {
      __stageBudgets: { mappingHealth: 1 },
      __testHooks: {
        afterMappingHealth: async () => {
          await sleep(10);
        }
      }
    }
  );

  // Both entries should fail with ERR_STAGE_BUDGET_PRE_PARSE; the typed code
  // and details must reach the per-entry result so callers can detect budget
  // exhaustion in batch mode without parsing the message string.
  assert.equal(output.results.length, 2);
  for (const entry of output.results) {
    assert.ok(entry.error, "expected per-entry error message");
    assert.equal(entry.errorCode, "ERR_STAGE_BUDGET_PRE_PARSE");
    assert.ok(entry.errorDetails, "expected per-entry errorDetails");
    assert.equal(entry.errorDetails!.failedStage, "mapping-health");
    assert.equal(entry.errorDetails!.stageBudgetExhausted, true);
    assert.equal(entry.errorDetails!.budgetMs, 1);
    assert.equal(typeof entry.errorDetails!.elapsedMs, "number");
  }
});
