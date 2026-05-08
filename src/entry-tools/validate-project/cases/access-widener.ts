import { readFile } from "node:fs/promises";
import { buildEntryToolResult, createSummarySubject, type DetailLevel } from "../../response-contract.js";
import { ERROR_CODES, createError } from "../../../errors.js";
import { buildSuggestedCall } from "../../../build-suggested-call.js";
import type { ValidateProjectInput } from "../../validate-project-service.js";
import { type ValidateProjectDeps } from "../internal.js";

export async function handleAccessWidener(
  deps: ValidateProjectDeps,
  input: ValidateProjectInput,
  detail: DetailLevel,
  include: string[]
) {
if (input.subject.kind !== "access-widener") {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=access-widener requires subject.kind=access-widener.",
    details: {
      task: input.task,
      subjectKind: input.subject.kind,
      failedStage: "input-validation",
      nextAction: "Set subject.kind to \"access-widener\" for task=\"access-widener\"."
    }
  });
}
if (!input.version) {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=access-widener requires version.",
    details: {
      task: "access-widener",
      failedStage: "input-validation",
      nextAction:
        "Pass version explicitly (e.g. \"1.21.10\"). Access Widener validation resolves class names against a specific Minecraft version.",
      ...buildSuggestedCall({
        tool: "validate-project",
        params: {
          task: "access-widener",
          subject: input.subject,
          version: "1.21.10"
        }
      })
    }
  });
}
const content = input.subject.input.mode === "inline"
  ? input.subject.input.content
  : await readFile(input.subject.input.path, "utf8");
const output = await deps.validateAccessWidener({
  content,
  version: input.version,
  mapping: input.mapping,
  sourcePriority: input.sourcePriority,
  scope: input.scope,
  preferProjectVersion: input.preferProjectVersion
});
return {
  ...buildEntryToolResult({
    task: "access-widener",
    detail,
    include,
    summary: {
      status: output.valid ? "ok" : "invalid",
      headline: output.valid
        ? "Access Widener is valid."
        : "Access Widener contains validation issues.",
      subject: createSummarySubject({
        task: "access-widener",
        kind: input.subject.kind,
        input: input.subject.input,
        version: input.version,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority
      }),
      counts: {
        valid: output.valid ? 1 : 0,
        invalid: output.valid ? 0 : 1
      }
    },
    blocks: {
      project: {
        summary: {
          total: 1,
          valid: output.valid ? 1 : 0,
          invalid: output.valid ? 0 : 1
        }
      },
      issues: include.includes("issues") || detail !== "summary" ? output.issues : undefined
    },
    alwaysBlocks: ["project"]
  }),
  warnings: Array.isArray(output.warnings) ? output.warnings : []
};
}
