import { readFile } from "node:fs/promises";
import { buildEntryToolResult, createSummarySubject, type DetailLevel } from "../../response-contract.js";
import { ERROR_CODES, createError } from "../../../errors.js";
import { buildSuggestedCall } from "../../../build-suggested-call.js";
import type { ValidateProjectInput } from "../../validate-project-service.js";
import { type ValidateProjectDeps } from "../internal.js";

export async function handleAccessTransformer(
  deps: ValidateProjectDeps,
  input: ValidateProjectInput,
  detail: DetailLevel,
  include: string[]
) {
if (input.subject.kind !== "access-transformer") {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=access-transformer requires subject.kind=access-transformer.",
    details: {
      task: input.task,
      subjectKind: input.subject.kind,
      failedStage: "input-validation",
      nextAction:
        "Set subject.kind to \"access-transformer\" for task=\"access-transformer\"."
    }
  });
}
if (!input.version) {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=access-transformer requires version.",
    details: {
      task: "access-transformer",
      failedStage: "input-validation",
      nextAction:
        "Pass version explicitly (e.g. \"1.21.10\"). Access Transformer validation resolves class names against a specific Minecraft version.",
      ...buildSuggestedCall({
        tool: "validate-project",
        params: {
          task: "access-transformer",
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
if (!deps.validateAccessTransformer) {
  throw createError({
    code: ERROR_CODES.CONTEXT_UNRESOLVED,
    message: "Access Transformer validation is not configured.",
    details: {
      task: "access-transformer",
      failedStage: "dependency-resolution",
      nextAction:
        "The current runtime was built without an Access Transformer validator. Rebuild the MCP server with validateAccessTransformer configured, or use task=\"access-widener\" if the workspace uses Fabric AccessWideners."
    }
  });
}
const output = await deps.validateAccessTransformer({
  content,
  version: input.version,
  atNamespace: input.atNamespace,
  sourcePriority: input.sourcePriority,
  scope: input.scope,
  preferProjectVersion: input.preferProjectVersion
});
const issueEntries = Array.isArray(output.entries)
  ? output.entries.filter((entry) => {
      if (!entry || typeof entry !== "object" || !("valid" in entry)) {
        return true;
      }
      return (entry as { valid?: boolean }).valid !== true;
    })
  : undefined;
return {
  ...buildEntryToolResult({
    task: "access-transformer",
    detail,
    include,
    summary: {
      status: output.valid ? "ok" : "invalid",
      headline: output.valid
        ? "Access Transformer is valid."
        : "Access Transformer contains validation issues.",
      subject: createSummarySubject({
        task: "access-transformer",
        kind: input.subject.kind,
        input: input.subject.input,
        version: input.version,
        sourcePriority: input.sourcePriority,
        scope: input.scope,
        atNamespace: input.atNamespace
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
      issues: include.includes("issues") || detail !== "summary" ? issueEntries : undefined
    },
    alwaysBlocks: ["project"]
  }),
  warnings: Array.isArray(output.warnings) ? output.warnings : []
};
}
