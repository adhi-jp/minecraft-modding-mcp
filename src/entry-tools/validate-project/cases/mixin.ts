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
        "Pass version explicitly: the Minecraft version this project targets. task=\"project-summary\" supports preferProjectVersion for auto-detection from gradle.properties, but direct task=\"mixin\" requires an explicit version. Call the suggested list-versions to see what is available, then replay the exampleCalls template with that version substituted.",
      // No concrete version can be derived here -- the caller omitted it and this
      // task does not auto-detect one. A `suggestedCall` is a payload the caller
      // may replay verbatim, so filling the hole with a made-up version produced
      // a call that RUNS and validates the mixin against the wrong Minecraft
      // version, which is worse than no suggestion.
      //
      // So the two roles are split, following what the sibling "a version is
      // required but none was resolved" site already does in
      // src/source/class-source.ts: `suggestedCall` is a REAL next step that
      // needs nothing the caller does not have (list-versions takes no
      // arguments and answers exactly the question blocking them), while the
      // task="mixin" retry shape travels as an `exampleCalls` template whose
      // placeholder makes the substitution the caller must perform obvious.
      ...buildSuggestedCall({ tool: "list-versions", params: {} }),
      ...buildSuggestedCall({
        tool: "validate-project",
        params: undefined,
        examples: [
          {
            params: {
              task: "mixin",
              subject: input.subject,
              version: "<your-mc-version>"
            },
            reason:
              "Replace <your-mc-version> with the Minecraft version this project targets (gradle.properties, or task=\"project-summary\" with preferProjectVersion=true reports it)."
          }
        ]
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
