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
let content: string;
if (input.subject.input.mode === "inline") {
  content = input.subject.input.content;
} else {
  const awPath = input.subject.input.path;
  try {
    content = await readFile(awPath, "utf8");
  } catch (err) {
    const osCode = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Could not read access widener file "${awPath}": ${osCode} - ${err instanceof Error ? err.message : String(err)}`,
      details: {
        task: "access-widener",
        failedStage: "input-validation",
        nextAction: `Verify the file exists and is readable at "${awPath}".`
      }
    });
  }
}
const output = await deps.validateAccessWidener({
  content,
  version: input.version,
  mapping: input.mapping,
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
      issues: include.includes("issues") || detail !== "summary" ? issueEntries : undefined
    },
    alwaysBlocks: ["project"]
  }),
  warnings: Array.isArray(output.warnings) ? output.warnings : []
};
}
