import { buildEntryToolResult, createSummarySubject, type DetailLevel } from "../../response-contract.js";
import { ERROR_CODES, createError } from "../../../errors.js";
import { buildSuggestedCall } from "../../../build-suggested-call.js";
import type { ValidateProjectInput } from "../../validate-project-service.js";
import { type ValidateProjectDeps } from "../internal.js";

export async function handleMixin(
  deps: ValidateProjectDeps,
  input: ValidateProjectInput,
  detail: DetailLevel,
  include: string[]
) {
if (input.subject.kind !== "mixin") {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=mixin requires subject.kind=mixin.",
    details: {
      task: input.task,
      subjectKind: input.subject.kind,
      failedStage: "input-validation",
      nextAction: "Set subject.kind to \"mixin\" for task=\"mixin\"."
    }
  });
}
if (!input.version) {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=mixin requires version.",
    details: {
      task: "mixin",
      failedStage: "input-validation",
      nextAction:
        "Pass version explicitly (e.g. \"1.21.10\"). task=\"project-summary\" supports preferProjectVersion for auto-detection from gradle.properties, but direct task=\"mixin\" requires an explicit version.",
      ...buildSuggestedCall({
        tool: "validate-project",
        params: {
          task: "mixin",
          subject: input.subject,
          version: "1.21.10"
        }
      })
    }
  });
}
const output = await deps.validateMixin({
  input: input.subject.input,
  version: input.version,
  mapping: input.mapping,
  sourcePriority: input.sourcePriority,
  scope: input.scope,
  preferProjectVersion: input.preferProjectVersion,
  preferProjectMapping: input.preferProjectMapping,
  sourceRoots: input.sourceRoots,
  minSeverity: input.minSeverity,
  hideUncertain: input.hideUncertain,
  explain: input.explain,
  warningMode: input.warningMode,
  warningCategoryFilter: input.warningCategoryFilter,
  treatInfoAsWarning: input.treatInfoAsWarning,
  includeIssues: input.includeIssues,
  reportMode: input.reportMode
});
const summary = output.summary as {
  total?: number;
  valid?: number;
  partial?: number;
  invalid?: number;
} | undefined;
const invalidCount = summary?.invalid ?? 0;
const partialCount = summary?.partial ?? 0;
return {
  ...buildEntryToolResult({
    task: "mixin",
    detail,
    include,
    summary: {
      status: invalidCount > 0 ? "invalid" : partialCount > 0 ? "partial" : "ok",
      headline: `Validated ${summary?.total ?? 0} mixin input(s).`,
      subject: createSummarySubject({
        task: "mixin",
        kind: input.subject.kind,
        input: input.subject.input,
        version: input.version,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        scope: input.scope
      }),
      counts: {
        valid: summary?.valid ?? 0,
        partial: partialCount,
        invalid: invalidCount
      }
    },
    blocks: {
      project: {
        summary
      },
      issues: include.includes("issues") || detail !== "summary" ? output.results : undefined
    },
    alwaysBlocks: ["project"]
  }),
  warnings: Array.isArray(output.warnings) ? output.warnings : []
};
}
