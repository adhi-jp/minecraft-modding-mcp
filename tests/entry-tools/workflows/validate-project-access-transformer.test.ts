import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../../src/errors.ts";
import { ValidateProjectService } from "../../../src/entry-tools/validate-project-service.ts";
import type { ValidateProjectDeps } from "../../../src/entry-tools/validate-project/internal.ts";

function createService(overrides: Partial<ValidateProjectDeps> = {}): ValidateProjectService {
  return new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    ...overrides
  });
}

// The public tool schema already rejects this combination at parse time; calling the
// service directly exercises the handler's own defense-in-depth guard.
test("rejects with ERR_INVALID_INPUT when task access-transformer receives a subject of a different kind", async () => {
  let validatorCalls = 0;
  const service = createService({
    validateAccessTransformer: async () => {
      validatorCalls += 1;
      throw new Error("must not be called");
    }
  });

  await assert.rejects(
    () =>
      service.execute({
        task: "access-transformer",
        detail: "summary",
        version: "1.21.10",
        subject: {
          kind: "access-widener",
          input: { mode: "inline", content: "accessWidener v2 named" }
        }
      }),
    (error: any) =>
      error.code === ERROR_CODES.INVALID_INPUT &&
      error.message === "task=access-transformer requires subject.kind=access-transformer." &&
      error.details?.failedStage === "input-validation" &&
      error.details?.task === "access-transformer" &&
      error.details?.subjectKind === "access-widener" &&
      typeof error.details?.nextAction === "string"
  );
  assert.equal(validatorCalls, 0);
});

test("reads path-mode input from the file and forwards its content to the access transformer validator", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-at-path-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const atPath = join(root, "accesstransformer.cfg");
  await writeFile(atPath, "public net.minecraft.server.MinecraftServer\n", "utf8");

  let seenValidatorInput: { content?: string; version?: string; atNamespace?: string } | undefined;
  const service = createService({
    validateAccessTransformer: async (input) => {
      seenValidatorInput = input;
      return {
        valid: true,
        entries: [],
        summary: { total: 1, valid: 1, invalid: 0 },
        warnings: []
      };
    }
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "summary",
    version: "1.21.10",
    atNamespace: "mojang",
    subject: {
      kind: "access-transformer",
      input: { mode: "path", path: atPath }
    }
  });

  assert.equal(seenValidatorInput?.content, "public net.minecraft.server.MinecraftServer\n");
  assert.equal(seenValidatorInput?.version, "1.21.10");
  assert.equal(seenValidatorInput?.atNamespace, "mojang");
  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
  assert.deepEqual(result.summary.subject?.input, { mode: "path", path: atPath });
});

test("propagates the raw filesystem error when the path-mode file does not exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-at-missing-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let validatorCalls = 0;
  const service = createService({
    validateAccessTransformer: async () => {
      validatorCalls += 1;
      throw new Error("must not be called");
    }
  });

  await assert.rejects(
    () =>
      service.execute({
        task: "access-transformer",
        detail: "summary",
        version: "1.21.10",
        subject: {
          kind: "access-transformer",
          input: { mode: "path", path: join(root, "missing.cfg") }
        }
      }),
    (error: any) => error.code === "ENOENT"
  );
  assert.equal(validatorCalls, 0);
});

test("rejects with ERR_CONTEXT_UNRESOLVED when the runtime has no access transformer validator configured", async () => {
  const service = createService();

  await assert.rejects(
    () =>
      service.execute({
        task: "access-transformer",
        detail: "summary",
        version: "1.21.10",
        subject: {
          kind: "access-transformer",
          input: { mode: "inline", content: "public net.minecraft.server.MinecraftServer" }
        }
      }),
    (error: any) =>
      error.code === ERROR_CODES.CONTEXT_UNRESOLVED &&
      error.message === "Access Transformer validation is not configured." &&
      error.details?.failedStage === "dependency-resolution" &&
      error.details?.task === "access-transformer" &&
      typeof error.details?.nextAction === "string" &&
      error.details.nextAction.includes('task="access-widener"')
  );
});

test("keeps malformed validator entries in the issues block while dropping entries marked valid", async () => {
  const service = createService({
    validateAccessTransformer: async () => ({
      valid: false,
      entries: [
        { target: "net.minecraft.A", valid: true },
        "unparseable line 3",
        { target: "net.minecraft.B" },
        null,
        { target: "net.minecraft.C", valid: false, issue: "not found" }
      ],
      summary: { total: 5, valid: 1, invalid: 4 },
      warnings: []
    })
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "full",
    version: "1.21.10",
    subject: {
      kind: "access-transformer",
      input: { mode: "inline", content: "public net.minecraft.A" }
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(result.summary.headline, "Access Transformer contains validation issues.");
  assert.deepEqual(result.issues, [
    "unparseable line 3",
    { target: "net.minecraft.B" },
    null,
    { target: "net.minecraft.C", valid: false, issue: "not found" }
  ]);
});

test("omits the issues block when the validator output has no entries array", async () => {
  const service = createService({
    validateAccessTransformer: async () => ({
      valid: false,
      summary: { total: 1, valid: 0, invalid: 1 },
      warnings: []
    })
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "full",
    version: "1.21.10",
    subject: {
      kind: "access-transformer",
      input: { mode: "inline", content: "public net.minecraft.A" }
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(result.project?.summary?.invalid, 1);
  assert.equal("issues" in result, false);
});

test("surfaces the issues block at summary detail only when include lists issues", async () => {
  const deps: Partial<ValidateProjectDeps> = {
    validateAccessTransformer: async () => ({
      valid: false,
      entries: [{ target: "net.minecraft.C", valid: false, issue: "Field missing" }],
      summary: { total: 1, valid: 0, invalid: 1 },
      warnings: []
    })
  };
  const input = {
    task: "access-transformer",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "access-transformer",
      input: { mode: "inline", content: "public net.minecraft.C" }
    }
  } as const;

  const withInclude = await createService(deps).execute({ ...input, include: ["issues"] });
  assert.equal(Array.isArray(withInclude.issues), true);
  assert.deepEqual(withInclude.issues, [{ target: "net.minecraft.C", valid: false, issue: "Field missing" }]);

  const withoutInclude = await createService(deps).execute({ ...input });
  assert.equal(withoutInclude.issues, undefined);
});

test("defaults warnings to an empty array when the validator output omits warnings", async () => {
  const service = createService({
    validateAccessTransformer: async () => ({
      valid: true,
      entries: [],
      summary: { total: 1, valid: 1, invalid: 0 }
    })
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "access-transformer",
      input: { mode: "inline", content: "public net.minecraft.A" }
    }
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.status, "ok");
  assert.deepEqual(result.summary.counts, { valid: 1, invalid: 0 });
});
