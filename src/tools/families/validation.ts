import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { parseAccessWidener } from "../../access-widener-parser.js";
import {
  discoverWorkspaceAccessTransformers,
  discoverWorkspaceAccessWideners,
  discoverWorkspaceMixins,
  type ValidateProjectInput
} from "../../entry-tools/validate-project-service.js";
import { handleProjectSummary } from "../../entry-tools/validate-project/cases/project-summary.js";
import { buildEarlyTasksForBlocked, type ValidateProjectDeps } from "../../entry-tools/validate-project/internal.js";
import { VerifyMixinTargetService } from "../../entry-tools/verify-mixin-target-service.js";
import { createError, ERROR_CODES, isAppError, type ErrorCode } from "../../errors.js";
import { normalizeOptionalProjectPath } from "../../gradle-paths.js";
import type { ValidationIssue } from "../../mixin/types.js";
import { normalizePathForHost } from "../../path-converter.js";
import type {
  ResolveArtifactOutput,
  ValidateAccessTransformerOutput,
  ValidateAccessWidenerOutput,
  ValidateMixinBatchResult,
  ValidateMixinInput,
  ValidateMixinOutput
} from "../../source-service.js";
import type { StageEmitter } from "../../stage-emitter.js";
import type { AccessTransformerNamespace, SourceMapping } from "../../types.js";
import {
  describeResolvedArtifact,
  toResolveArtifactRequest,
  withCatalogFieldPaths,
  type CatalogTarget
} from "../artifact-target.js";
import { defined, failedItem, FollowUps } from "../items.js";
import {
  ARTIFACT_SCOPES,
  detailSchema,
  MAPPING_NAMESPACES,
  mappingSchema,
  nonEmptyString,
  NOT_IN_SIMPLE_MEMBER_NAME,
  SIMPLE_MEMBER_NAME_MESSAGE,
  targetSchema,
  type DetailLevel
} from "../schemas.js";
import { translateServiceSuggestedCall, translateToolNamesInText } from "../translation.js";
import type {
  CatalogCall,
  CatalogNextAction,
  CatalogServices,
  CatalogStatus,
  CatalogToolSpec,
  CatalogWarning
} from "../types.js";
import { isRoutineNotice } from "../warnings.js";

/**
 * Validation family: mixin source checked against a Minecraft version's
 * bytecode, a Loom workspace's discovered mixin configs, access wideners and
 * access transformers, one access widener or transformer, and one mixin
 * target member. `mixin-validate` and `project-validate` are long-running:
 * the stdio supervisor gives them its deadline and runs each call alone.
 */

// ---------------------------------------------------------------------------
// Service text
// ---------------------------------------------------------------------------

/**
 * Whole service sentences that name an 8.x tool or an input the catalog tools
 * do not have, with their catalog wording. Only these exact sentences are
 * rewritten; any other text is kept as the service wrote it.
 */
const SERVICE_SENTENCES: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  {
    // The automatic retry of a partial mixin validation (src/source/validate-mixin.ts).
    pattern: /Retrying validate-mixin with sourcePriority="maven-first" after partial validation using "([^"]+)"\./g,
    replacement: 'Retried the validation with Maven mapping sources first after a partial result from "$1" sources.'
  },
  {
    // A mixin file that could not be read (src/source/validate-mixin.ts).
    pattern: /Could not read sourcePath "([^"]*)" \(resolved to "([^"]*)"\):/g,
    replacement: 'Could not read the mixin file "$1" (resolved to "$2"):'
  },
  {
    // A mixin result's quick summary when the stage budget ran out (src/mixin/helpers.ts).
    pattern: /Budget exhausted before any target processed — increase budget or split mixinConfigPath\./g,
    replacement: "Budget exhausted before any target processed — validate fewer mixin files per call."
  },
  {
    pattern: /(\d+) target\(s\) deferred by stage budget — narrow mixinConfigPath or split the run\./g,
    replacement: "$1 target(s) deferred by stage budget — validate fewer mixin files per call."
  },
  {
    // Mixin discovery that found no config (src/source/validate-mixin.ts).
    pattern:
      /Use input\.mode='config' with explicit configPaths\[\], or point input\.path at the workspace root that contains \*\.mixins\.json files\./g,
    replacement:
      "Pass configPaths with the mixin config files, or point projectPath at the workspace root that contains *.mixins.json files."
  },
  {
    // A project with nothing to validate (src/entry-tools/validate-project/cases/project-summary.ts).
    pattern: /Access Transformer files are searched only when subject\.discover includes "access-transformers"\./g,
    replacement: 'Access Transformer files are searched only when discover includes "access-transformers".'
  },
  {
    // An access transformer whose namespace the workspace does not tell (src/source/artifact-resolver.ts).
    pattern: /Could not infer atNamespace from the workspace\./g,
    replacement: "Could not infer the access transformer namespace from the workspace."
  },
  {
    // An SRG access transformer checked outside the loader jar (src/source/access-validate.ts,
    // src/source/artifact-resolver.ts).
    pattern: /atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved\./g,
    replacement: 'An SRG access transformer needs scope "loader" so a Forge runtime jar can be resolved.'
  },
  {
    // A runtime jar of another loader than the workspace's (src/source/access-validate.ts).
    pattern:
      /Point gradleUserHome at the Gradle home holding this workspace's own (\S+) runtime jars, or run the Gradle task that generates them\./g,
    replacement:
      "Point the server's GRADLE_USER_HOME at the Gradle home holding this workspace's own $1 runtime jars, or run the Gradle task that generates them."
  },
  {
    pattern: /Omitting projectPath validates against the vanilla jar instead of another loader's\./g,
    replacement: "Omitting projectPath and scope validates against the vanilla jar instead of another loader's."
  },
  {
    // A transformer runtime jar the workspace and the Gradle caches lack (src/source/artifact-resolver.ts).
    pattern:
      /Searched the workspace "([^"]*)" and the Gradle caches but found no runtime jar for Minecraft (\S+) \(the workspace declares ([^;]+); retry with version="([^"]+)" or preferProjectVersion=true\)\./g,
    replacement:
      'Searched the workspace "$1" and the Gradle caches but found no runtime jar for Minecraft $2 (the workspace declares $3; retry with version="$4").'
  },
  {
    // A mixin target named in another namespace than the artifact's, with autoRemap off
    // (src/entry-tools/verify-mixin-target-service.ts).
    pattern:
      /verify-mixin-target requires owner and member\.name to be in the artifact's namespace \("([^"]+)"\), but the request supplied mapping="([^"]+)"\. Set autoRemap=true to translate names automatically, supply owner\+member in the artifact namespace, or omit the mapping argument so the resolver picks the namespace automatically\./g,
    replacement:
      'With autoRemap: false, className and memberName must be in the artifact\'s namespace ("$1"), but the request has mapping "$2". Omit autoRemap (it defaults to true) to translate the names, or pass mapping "$1" with the names in that namespace.'
  },
  {
    pattern:
      /Retry with autoRemap=true, or with mapping="([^"]+)" and owner\/member already in that namespace, or use find-mapping to translate before calling verify-mixin-target\./g,
    replacement:
      'Retry without autoRemap: false, or with mapping "$1" and className and memberName in that namespace (symbol-map translates them).'
  },
  {
    // A mixin target class autoRemap could not translate (src/entry-tools/verify-mixin-target-service.ts).
    pattern: /autoRemap could not translate owner "([^"]+)" from (\S+) to (\S+)\./g,
    replacement: 'autoRemap could not translate class "$1" from $2 to $3.'
  },
  {
    pattern: /Confirm "([^"]+)" exists in (\S+) for ([^,\s]+), or supply owner\/member already in (\S+)\./g,
    replacement: 'Confirm "$1" exists in $2 for $3, or pass mapping "$4" with className and memberName in that namespace.'
  },
  {
    // An artifact without a binary jar (src/entry-tools/verify-mixin-target-service.ts).
    pattern:
      /Re-target with target: \{ kind: "jar", value: "<path to the jar>" \}, or with a version whose artifact carries one \(resolve-artifact reports binaryJarPath for the target you pass\)\./g,
    replacement:
      'Re-target with target: { kind: "jar", jarPath: "<path to the jar>" }, or with a version whose artifact carries one (artifact-resolve with detail "standard" reports binaryJarPath for the target you pass).'
  }
];

/** `text` with each known service sentence in its catalog wording. */
export function catalogServiceText(text: string): string {
  return SERVICE_SENTENCES.reduce((current, { pattern, replacement }) => current.replace(pattern, replacement), text);
}

/** A service error with its message and `nextAction` in catalog wording; any other error passes. */
function catalogServiceError(caught: unknown): unknown {
  if (!isAppError(caught)) return caught;
  const message = catalogServiceText(caught.message);
  const nextAction = caught.details?.nextAction;
  const rewrittenAction = typeof nextAction === "string" ? catalogServiceText(nextAction) : nextAction;
  if (message === caught.message && rewrittenAction === nextAction) return caught;
  return createError({
    code: caught.code,
    message,
    details: { ...caught.details, ...(typeof nextAction === "string" ? { nextAction: rewrittenAction } : {}) }
  });
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** How each `detail` level asks the mixin service to report. */
const MIXIN_REPORT: Readonly<Record<DetailLevel, { reportMode: "summary-first" | "compact" | "full"; explain: boolean }>> = {
  summary: { reportMode: "summary-first", explain: false },
  standard: { reportMode: "compact", explain: true },
  full: { reportMode: "full", explain: true }
};

/**
 * The status of one validated mixin class: `invalid` only for definite
 * errors; errors the service marks uncertain (a name it could not map) and
 * incomplete checks are `partial`.
 */
function mixinResultStatus(result: { valid: boolean; validationStatus: string }): CatalogStatus {
  if (result.validationStatus === "full") return "ok";
  return result.valid ? "partial" : "invalid";
}

/** `invalid` when any item is, else `partial` when any is partial or failed, else `ok`. */
function overallStatus(statuses: readonly CatalogStatus[]): CatalogStatus {
  if (statuses.includes("invalid")) return "invalid";
  if (statuses.some((status) => status !== "ok")) return "partial";
  return "ok";
}

/** The issues without their in-result suggested calls, which become catalog next actions. */
function issuesWithoutSuggestions(issues: readonly ValidationIssue[], followUps: FollowUps): Array<Omit<ValidationIssue, "suggestedCall">> {
  return issues.map(({ suggestedCall, ...issue }) => {
    followUps.addServiceCall(suggestedCall);
    return issue;
  });
}

async function readProjectVersion(services: CatalogServices, projectPath: string): Promise<string | undefined> {
  const detected = await services.workspaceMappingService.detectProjectMinecraftVersion(projectPath);
  return detected?.trim() || undefined;
}

/** The mapping the project's build declares, or why none could be read. */
async function readProjectMapping(
  services: CatalogServices,
  projectPath: string
): Promise<{ mapping?: SourceMapping; reason?: string }> {
  try {
    const detection = await services.workspaceMappingService.detectCompileMapping({ projectPath });
    if (detection.resolved && detection.mappingApplied !== undefined) return { mapping: detection.mappingApplied };
    return { reason: detection.warnings[0] };
  } catch (caught) {
    return { reason: caught instanceof Error ? caught.message : String(caught) };
  }
}

function versionReadWarning(version: string, projectPath: string): CatalogWarning {
  return {
    code: "version-from-project",
    severity: "info",
    message: `Read Minecraft version ${version} from ${join(projectPath, "gradle.properties")}.`
  };
}

function mappingReadWarning(mapping: string): CatalogWarning {
  return { code: "mapping-from-project", severity: "info", message: `Read mapping ${mapping} from the project's build script.` };
}

function versionMissingWarning(projectPath: string): CatalogWarning {
  return {
    code: "version-unresolved",
    severity: "warning",
    message:
      `No version was given and ${join(projectPath, "gradle.properties")} declares none ` +
      "(minecraft_version, mc_version or minecraftVersion); pass version."
  };
}

function mappingMissingWarning(reason: string | undefined): CatalogWarning {
  return {
    code: "mapping-unresolved",
    severity: "warning",
    message: `No mapping was given and none could be read from the project's build scripts${reason ? ` (${reason})` : ""}; pass mapping.`
  };
}

/**
 * The namespace a discovered access widener is checked in. An explicit
 * `mapping` wins over every header. A `named` header means the project's
 * development names, so it takes the project's mapping (given or read from the
 * build); `official`, `intermediary` and the other headers keep their own
 * namespace (undefined lets the service read the header).
 */
function widenerMapping(
  content: string,
  explicit: SourceMapping | undefined,
  project: SourceMapping | undefined
): SourceMapping | undefined {
  if (explicit !== undefined) return explicit;
  return parseAccessWidener(content).namespace.trim().toLowerCase() === "named" ? project : undefined;
}

const PLACEHOLDERS = { version: "<minecraft-version>", mapping: "<mapping>" } as const;

// ---------------------------------------------------------------------------
// mixin-validate
// ---------------------------------------------------------------------------

const MIXIN_INPUT_FORMS = ["source", "paths", "configPaths", "discover"] as const;

const mixinValidateInput = z
  .strictObject({
    source: z.string().trim().min(1, "source must not be blank.").optional().describe("Mixin Java source text."),
    paths: z.array(nonEmptyString).min(1).optional().describe("Mixin .java files."),
    configPaths: z.array(nonEmptyString).min(1).optional().describe("Mixin config JSON files (modid.mixins.json)."),
    discover: z.literal(true).optional().describe("true: every *.mixins.json under projectPath."),
    projectPath: nonEmptyString
      .optional()
      .describe("Loom project: jar lookup, config source roots, default version and mapping."),
    version: nonEmptyString.optional().describe("Minecraft version; required without projectPath."),
    mapping: mappingSchema.optional().describe("Namespace of the mixin's names; required without projectPath."),
    scope: z.enum(ARTIFACT_SCOPES).optional().describe("vanilla (default), merged or loader; the latter two need projectPath."),
    detail: detailSchema("summary").describe("standard adds explanations and next actions; full adds all evidence.")
  })
  .superRefine((value, ctx) => {
    const given = MIXIN_INPUT_FORMS.filter((key) => value[key] !== undefined);
    if (given.length === 0) {
      ctx.addIssue({ code: "custom", path: [], message: "Pass exactly one of source, paths, configPaths, discover." });
    } else if (given.length > 1) {
      for (const key of given) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Pass exactly one of source, paths, configPaths, discover; this request has ${given.join(", ")}.`
        });
      }
    }
    if (value.discover === true && value.projectPath === undefined) {
      ctx.addIssue({ code: "custom", path: ["projectPath"], message: "discover: true needs projectPath, the directory to search." });
    }
    if (value.projectPath === undefined) {
      for (const key of ["version", "mapping"] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required without projectPath (with projectPath it is read from the project).`
          });
        }
      }
      if (value.scope === "merged" || value.scope === "loader") {
        ctx.addIssue({ code: "custom", path: ["scope"], message: `scope "${value.scope}" needs projectPath.` });
      }
    }
  });

type MixinValidateInput = z.output<typeof mixinValidateInput>;

/** The service's input form for the one form the request names. */
function mixinServiceForm(input: MixinValidateInput, projectPath: string | undefined): ValidateMixinInput["input"] {
  if (input.source !== undefined) return { mode: "inline", source: input.source };
  if (input.paths !== undefined) return { mode: "paths", paths: input.paths };
  if (input.configPaths !== undefined) return { mode: "config", configPaths: input.configPaths };
  return { mode: "project", path: projectPath! };
}

/** The request's own parameters, for a follow-up that repeats the call. */
function mixinRequestParams(input: MixinValidateInput): Record<string, unknown> {
  return defined({
    source: input.source,
    paths: input.paths,
    configPaths: input.configPaths,
    discover: input.discover,
    projectPath: input.projectPath,
    version: input.version,
    mapping: input.mapping,
    scope: input.scope,
    detail: input.detail
  });
}

/**
 * `counts` of a mixin-validate reply: the items by status, and the issue
 * totals the service counted across them.
 */
function mixinCounts(
  statuses: readonly CatalogStatus[],
  totals: { totalValidationErrors: number; totalValidationWarnings: number }
) {
  const count = (status: CatalogStatus) => statuses.filter((entry) => entry === status).length;
  return {
    total: statuses.length,
    ok: count("ok"),
    partial: count("partial"),
    invalid: count("invalid"),
    error: count("error"),
    validationErrors: totals.totalValidationErrors,
    validationWarnings: totals.totalValidationWarnings
  };
}

/** One validated source: the service's result for it, or the error it failed with. */
function mixinItem(
  entry: ValidateMixinBatchResult,
  detail: DetailLevel,
  call: CatalogCall,
  followUps: FollowUps
): Record<string, unknown> {
  const source = defined({ ...entry.source });
  if (entry.result === undefined) {
    const details = entry.errorDetails;
    const nextAction = details?.nextAction;
    const failure = createError({
      code: (entry.errorCode ?? ERROR_CODES.INTERNAL) as ErrorCode,
      message: catalogServiceText(entry.error ?? "The source could not be validated."),
      ...(details !== undefined
        ? { details: { ...details, ...(typeof nextAction === "string" ? { nextAction: catalogServiceText(nextAction) } : {}) } }
        : {})
    });
    return failedItem({ source }, failure, call, followUps, () => "error");
  }
  const { valid: _valid, validationStatus: _validationStatus, warnings, issues, quickSummary, ...rest } = entry.result;
  return {
    source,
    status: mixinResultStatus(entry.result),
    ...rest,
    ...(quickSummary !== undefined ? { quickSummary: catalogServiceText(quickSummary) } : {}),
    issues: issuesWithoutSuggestions(issues, followUps),
    ...(detail === "full" && warnings.length > 0
      ? { warnings: warnings.map((warning) => translateToolNamesInText(catalogServiceText(warning), call.tool)) }
      : {})
  };
}

export const mixinValidateSpec: CatalogToolSpec<MixinValidateInput> = {
  name: "mixin-validate",
  description:
    "Validate Mixin classes against a Minecraft version's bytecode. Pass exactly one of source, paths, configPaths " +
    "or discover:true (each *.mixins.json under projectPath). Without projectPath, version and mapping are required; " +
    "with it, an omitted one is read from the project, else the call is blocked. Long-running. " +
    'Example: {"configPaths":["/p/src/main/resources/m.mixins.json"],"projectPath":"/p"}',
  annotations: { readOnlyHint: true },
  inputSchema: mixinValidateInput,
  examples: [
    { configPaths: ["/path/to/project/src/main/resources/example.mixins.json"], projectPath: "/path/to/project" },
    { discover: true, projectPath: "/path/to/project", detail: "standard" },
    {
      source: "@Mixin(Entity.class)\npublic abstract class EntityMixin {}",
      version: "1.21.10",
      mapping: "mojang"
    }
  ],
  statuses: ["ok", "partial", "invalid", "blocked", "error"],
  primaryKey: "validation",
  // The handler shapes each level itself (the service's report options).
  detailProjection: { default: "summary", minimumLevel: {} },
  handler: async (input, call) => {
    const services = call.services;
    const projectPath = normalizeOptionalProjectPath(input.projectPath);
    const warnings: Array<string | CatalogWarning> = [];
    const missing: Array<keyof typeof PLACEHOLDERS> = [];

    let version = input.version;
    if (version === undefined && projectPath !== undefined) {
      version = await readProjectVersion(services, projectPath);
      if (version !== undefined) warnings.push(versionReadWarning(version, projectPath));
      else {
        missing.push("version");
        warnings.push(versionMissingWarning(projectPath));
      }
    }
    let mapping = input.mapping;
    if (mapping === undefined && projectPath !== undefined) {
      const read = await readProjectMapping(services, projectPath);
      mapping = read.mapping;
      if (mapping !== undefined) warnings.push(mappingReadWarning(mapping));
      else {
        missing.push("mapping");
        warnings.push(mappingMissingWarning(read.reason));
      }
    }

    if (missing.length > 0) {
      const placeholders = Object.fromEntries(missing.map((key) => [key, PLACEHOLDERS[key]]));
      return {
        result: {
          validation: {
            status: "blocked",
            counts: mixinCounts([], { totalValidationErrors: 0, totalValidationWarnings: 0 }),
            items: []
          }
        },
        warnings,
        nextActions: [
          {
            tool: "mixin-validate",
            params: { ...mixinRequestParams(input), ...placeholders },
            reason: `Validate with ${missing.join(" and ")} set: replace ${Object.values(placeholders).join(" and ")}.`,
            template: true
          }
        ]
      };
    }

    const report = MIXIN_REPORT[input.detail];
    let output: ValidateMixinOutput;
    try {
      output = await services.validateMixin(
        {
          input: mixinServiceForm(input, projectPath),
          version,
          mapping,
          ...defined({ scope: input.scope, projectPath }),
          reportMode: report.reportMode,
          explain: report.explain
        },
        call.stageEmitter !== undefined ? { stageEmitter: call.stageEmitter } : {}
      );
    } catch (caught) {
      throw catalogServiceError(caught);
    }

    const followUps = new FollowUps(call.tool);
    const items = output.results.map((entry) => mixinItem(entry, input.detail, call, followUps));
    const statuses = items.map((item) => item.status as CatalogStatus);
    const status = overallStatus(statuses);
    const nextActions: CatalogNextAction[] = followUps.list();
    if (input.detail === "summary" && statuses.some((entry) => entry === "invalid" || entry === "partial")) {
      nextActions.push({
        tool: "mixin-validate",
        params: { ...mixinRequestParams(input), detail: "standard" },
        reason: "Explain each issue and suggest the lookups that check it."
      });
    }
    return {
      result: {
        validation: {
          status,
          counts: mixinCounts(statuses, output.summary),
          items,
          ...defined({ provenance: output.provenance }),
          ...(input.detail === "full"
            ? defined({
                issueSummary: output.issueSummary,
                incompleteReasons: output.incompleteReasons,
                toolHealth: output.toolHealth,
                confidenceScore: output.confidenceScore
              })
            : {})
        }
      },
      warnings: [...warnings, ...output.warnings.map(catalogServiceText)],
      nextActions
    };
  }
};

// ---------------------------------------------------------------------------
// project-validate
// ---------------------------------------------------------------------------

const DISCOVER_KINDS = ["mixins", "access-wideners", "access-transformers"] as const;
type DiscoverKind = (typeof DISCOVER_KINDS)[number];

const projectValidateInput = z.strictObject({
  projectPath: nonEmptyString.describe("Root of the Loom workspace to search."),
  version: nonEmptyString.optional().describe("Minecraft version; default read from gradle.properties."),
  mapping: mappingSchema.optional().describe("Namespace of the mixins' names; default read from the build."),
  discover: z
    .array(z.enum(DISCOVER_KINDS))
    .min(1)
    .default(["mixins", "access-wideners"])
    .describe("File kinds to find and validate."),
  scope: z
    .enum(ARTIFACT_SCOPES)
    .optional()
    .describe("Jar to check; omitted: vanilla for mixins, loader for wideners and transformers."),
  detail: detailSchema("summary").describe("standard adds issues and file lists; full adds task evidence and provenance.")
});

type ProjectValidateInput = z.output<typeof projectValidateInput>;

type ProjectFileKind = "mixin-config" | "access-widener" | "access-transformer";

/** What validating one discovered file produced: the service's output or the error it threw. */
type FileRecord = { output?: Record<string, unknown> & { warnings?: string[] }; error?: unknown };

type ProjectItem = {
  path: string;
  kind: ProjectFileKind;
  status: CatalogStatus;
  errors?: string[];
  [key: string]: unknown;
};

function projectRequestParams(input: ProjectValidateInput): Record<string, unknown> {
  return defined({
    projectPath: input.projectPath,
    version: input.version,
    mapping: input.mapping,
    discover: input.discover,
    scope: input.scope,
    detail: input.detail
  });
}

/**
 * The task report: below `full` each task keeps its status, error and
 * warnings, as the 8.x report showed it. Routine notices are left out of the
 * task warnings as they are out of `meta.warnings`.
 */
function projectTasks(tasks: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tasks).map(([key, value]) => {
      const entry = value as Record<string, unknown>;
      const warnings = Array.isArray(entry.warnings)
        ? (entry.warnings as unknown[]).filter((warning) => typeof warning !== "string" || !isRoutineNotice(warning))
        : [];
      const { warnings: _warnings, ...rest } = entry;
      const kept = detail === "full" ? rest : defined({ status: entry.status, error: entry.error });
      return [key, { ...kept, ...(warnings.length > 0 ? { warnings } : {}) }];
    })
  );
}

function errorMessage(caught: unknown): string {
  return translateToolNamesInText(catalogServiceText(caught instanceof Error ? caught.message : String(caught)), "project-validate");
}

/** One mixin config: its status from its classes, the errors at every level, the issues from `standard`. */
function mixinConfigItem(
  path: string,
  record: FileRecord | undefined,
  detail: DetailLevel,
  followUps: FollowUps
): ProjectItem {
  if (record?.output === undefined) {
    return {
      path,
      kind: "mixin-config",
      status: "error",
      errors: [record?.error !== undefined ? errorMessage(record.error) : "The config was not validated."]
    };
  }
  const output = record.output as unknown as ValidateMixinOutput;
  const statuses: CatalogStatus[] = [];
  const errors: string[] = [];
  const issues: Array<Record<string, unknown>> = [];
  for (const entry of output.results) {
    if (entry.result === undefined) {
      statuses.push("error");
      errors.push(`${entry.source.label}: ${errorMessage(entry.error ?? "could not be validated.")}`);
      continue;
    }
    const result = entry.result;
    statuses.push(mixinResultStatus(result));
    for (const issue of result.issues) {
      if (issue.severity === "error") errors.push(`${result.className}: ${issue.message}`);
    }
    for (const issue of issuesWithoutSuggestions(result.issues, followUps)) {
      issues.push({ className: result.className, ...issue });
    }
  }
  return {
    path,
    kind: "mixin-config",
    status: overallStatus(statuses),
    ...(errors.length > 0 ? { errors } : {}),
    ...(detail !== "summary" ? { issues } : {}),
    ...(detail === "full" ? defined({ summary: output.summary, provenance: sharedProvenance(output) }) : {})
  };
}

/**
 * The provenance every class of a config shares (version, jar, namespaces,
 * scope): the service's hoisted provenance, else the classes' provenance
 * without their per-target resolution traces when it is the same for all.
 */
function sharedProvenance(output: ValidateMixinOutput): unknown {
  if (output.provenance !== undefined) return output.provenance;
  const provenances = output.results
    .map((entry) => entry.result?.provenance)
    .filter((entry) => entry !== undefined)
    .map(({ resolutionTrace: _trace, ...rest }) => rest);
  const [first] = provenances;
  return first !== undefined && provenances.every((entry) => isDeepStrictEqual(entry, first)) ? first : undefined;
}

/** One access widener or transformer: `ok` when every entry resolves, else `invalid`. */
function accessFileItem(
  path: string,
  kind: "access-widener" | "access-transformer",
  record: FileRecord | undefined,
  detail: DetailLevel
): ProjectItem {
  if (record?.output === undefined) {
    return {
      path,
      kind,
      status: "error",
      errors: [record?.error !== undefined ? errorMessage(record.error) : "The file could not be read."]
    };
  }
  const output = {
    ...(record.output as AccessFileOutput),
    entries: (record.output as AccessFileOutput).entries ?? [],
    warnings: (record.output as AccessFileOutput).warnings ?? []
  } as unknown as AccessOutput;
  // The same entry marks, status and errors as access-validate gives the file.
  const entries = accessEntries(output, kind);
  const status = accessStatus(output, entries);
  const warnings = output.warnings.map((warning) => translateToolNamesInText(catalogServiceText(warning), "project-validate"));
  const errors = status === "invalid" ? accessErrors(entries, warnings) : [];
  // The file's other warnings are reported with the call's warnings.
  const rejectedLines = warnings.filter((warning) => LINE_WARNING.test(warning));
  return {
    path,
    kind,
    status,
    ...(errors.length > 0 ? { errors } : {}),
    ...(detail !== "summary"
      ? { issues: [...entries.filter((entry) => entry.valid === false), ...rejectedLines.map((issue) => ({ issue }))] }
      : {}),
    ...(detail === "full"
      ? defined({
          summary: output.summary,
          provenance: output.provenance,
          approximate: output.approximate,
          approximationReasons: output.approximationReasons
        })
      : {})
  };
}

type AccessFileOutput = {
  valid?: boolean;
  entries?: Array<{ valid?: boolean; line?: number; issue?: string }>;
  summary?: unknown;
  provenance?: unknown;
  approximate?: boolean;
  approximationReasons?: string[];
  warnings?: string[];
};

/** `line <n>: <issue>`, unless the issue already starts with its line. */
function entryError(entry: { line?: number; issue?: string }): string {
  const issue = entry.issue ?? "invalid entry";
  return /^line \d+:/i.test(issue) ? issue : `line ${entry.line}: ${issue}`;
}

/** A `version-mismatch` warning for each access file checked against another version's jar. */
function approximationWarnings(paths: readonly string[], records: ReadonlyMap<string, FileRecord>): CatalogWarning[] {
  const warnings: CatalogWarning[] = [];
  for (const path of paths) {
    const output = records.get(path)?.output as AccessFileOutput | undefined;
    if (output?.approximate !== true) continue;
    const reasons = output.approximationReasons ?? [];
    warnings.push({
      code: "version-mismatch",
      severity: "warning",
      message: `${path} was checked against another version's runtime jar${reasons.length > 0 ? `: ${reasons.join(" ")}` : "."}`
    });
  }
  return warnings;
}

function itemCountsByStatus(items: readonly ProjectItem[]) {
  const count = (status: CatalogStatus) => items.filter((item) => item.status === status).length;
  return {
    total: items.length,
    ok: count("ok"),
    partial: count("partial"),
    invalid: count("invalid"),
    error: count("error"),
    blocked: count("blocked")
  };
}

type Discovered = Record<DiscoverKind, string[]>;

function blockedItems(discovered: Discovered): ProjectItem[] {
  return [
    ...discovered.mixins.map((path): ProjectItem => ({ path, kind: "mixin-config", status: "blocked" })),
    ...discovered["access-wideners"].map((path): ProjectItem => ({ path, kind: "access-widener", status: "blocked" })),
    ...discovered["access-transformers"].map(
      (path): ProjectItem => ({ path, kind: "access-transformer", status: "blocked" })
    )
  ];
}

function workspaceBlock(projectPath: string, discovered: Discovered) {
  return {
    projectPath,
    mixinConfigs: discovered.mixins,
    accessWideners: discovered["access-wideners"],
    accessTransformers: discovered["access-transformers"]
  };
}

async function discoverFiles(projectPath: string, discover: readonly DiscoverKind[]): Promise<Discovered> {
  const [mixins, accessWideners, accessTransformers] = await Promise.all([
    discover.includes("mixins") ? discoverWorkspaceMixins(projectPath) : Promise.resolve([]),
    discover.includes("access-wideners") ? discoverWorkspaceAccessWideners(projectPath) : Promise.resolve([]),
    discover.includes("access-transformers") ? discoverWorkspaceAccessTransformers(projectPath) : Promise.resolve([])
  ]);
  return { mixins, "access-wideners": accessWideners, "access-transformers": accessTransformers };
}

/** The project result of a call that could not start for want of an input. */
async function blockedProject(
  input: ProjectValidateInput,
  projectPath: string,
  discovered: Discovered,
  nextActions: CatalogNextAction[],
  warnings: Array<string | CatalogWarning>
) {
  const items = blockedItems(discovered);
  const tasks = await buildEarlyTasksForBlocked(projectPath, "full", ["workspace"]);
  return {
    result: {
      project: {
        status: "blocked",
        counts: itemCountsByStatus(items),
        items,
        tasks: projectTasks(tasks as unknown as Record<string, unknown>, input.detail),
        ...(input.detail !== "summary" ? { workspace: workspaceBlock(projectPath, discovered) } : {})
      }
    },
    warnings,
    nextActions
  };
}

export const projectValidateSpec: CatalogToolSpec<ProjectValidateInput> = {
  name: "project-validate",
  description:
    "Find and validate a Loom workspace's mixin configs and access wideners (access transformers on request) and " +
    "report each file's status. version and mapping default to the project's (gradle.properties, build script); " +
    "when one is needed and cannot be read, the call is blocked. Long-running. " +
    'Example: {"projectPath":"/path/to/project"}',
  annotations: { readOnlyHint: true },
  inputSchema: projectValidateInput,
  examples: [
    { projectPath: "/path/to/project" },
    { projectPath: "/path/to/project", discover: ["mixins", "access-transformers"], detail: "standard" }
  ],
  statuses: ["ok", "partial", "invalid", "blocked", "error"],
  primaryKey: "project",
  // The handler shapes each level itself (the service's report options).
  detailProjection: { default: "summary", minimumLevel: {} },
  handler: async (input, call) => {
    const services = call.services;
    const projectPath = normalizeOptionalProjectPath(input.projectPath)!;
    const warnings: Array<string | CatalogWarning> = [];
    const request = projectRequestParams(input);

    let mapping = input.mapping;
    let initialDiscovery: Discovered | undefined;
    if (mapping === undefined) {
      const read = await readProjectMapping(services, projectPath);
      mapping = read.mapping;
      if (mapping !== undefined) {
        warnings.push(mappingReadWarning(mapping));
      } else {
        const discovered = await discoverFiles(projectPath, input.discover);
        initialDiscovery = discovered;
        if (discovered.mixins.length > 0) {
          // Mixin names cannot be looked up without their namespace.
          const missing: Array<keyof typeof PLACEHOLDERS> = ["mapping"];
          const blockedWarnings: Array<string | CatalogWarning> = [mappingMissingWarning(read.reason)];
          if (input.version === undefined && (await readProjectVersion(services, projectPath)) === undefined) {
            missing.unshift("version");
            blockedWarnings.unshift(versionMissingWarning(projectPath));
          }
          const placeholders = Object.fromEntries(missing.map((key) => [key, PLACEHOLDERS[key]]));
          return blockedProject(input, projectPath, discovered, [
            {
              tool: "project-validate",
              params: { ...request, ...placeholders },
              reason: `Validate with ${missing.join(" and ")} set: replace ${Object.values(placeholders).join(" and ")}.`,
              template: true
            }
          ], blockedWarnings);
        }
        warnings.push({
          code: "mapping-unresolved",
          severity: "info",
          message:
            "No mapping was given or read from the build; no mixin config was found, so the Minecraft artifact " +
            "check was skipped and access wideners and transformers use their own namespace."
        });
      }
    }

    // What each discovered file produced, recorded by the dependencies the
    // project service calls. Access wideners and transformers are validated
    // one at a time, each right after the service reports the file it opens.
    const discovered: Discovered = { mixins: [], "access-wideners": [], "access-transformers": [] };
    const records = new Map<string, FileRecord>();
    const opening: { "access-widener"?: string; "access-transformer"?: string } = {};
    const record = async <T extends Record<string, unknown>>(path: string | undefined, run: () => Promise<T>): Promise<T> => {
      try {
        const output = await run();
        if (path !== undefined) records.set(path, { output });
        return output;
      } catch (caught) {
        if (path !== undefined) records.set(path, { error: caught });
        throw caught;
      }
    };
    const stageEmitter: StageEmitter = async (stage, meta) => {
      const filePath = typeof meta?.filePath === "string" ? meta.filePath : undefined;
      if (stage === "validate-project:access-widener-validation" && filePath !== undefined) {
        opening["access-widener"] = filePath;
      }
      if (stage === "validate-project:access-transformer-validation" && filePath !== undefined) {
        opening["access-transformer"] = filePath;
      }
      await call.stageEmitter?.(stage, meta);
    };
    const deps: ValidateProjectDeps = {
      validateMixin: (mixinInput, options) => {
        const configPaths = (mixinInput.input as { configPaths?: string[] } | undefined)?.configPaths;
        return record(configPaths?.[0], () =>
          services.validateMixin(mixinInput as unknown as ValidateMixinInput, options) as unknown as Promise<
            Record<string, unknown> & { warnings?: string[] }
          >
        );
      },
      validateAccessWidener: (awInput) =>
        record(opening["access-widener"], () =>
          services.validateAccessWidener({
            ...awInput,
            mapping: widenerMapping(awInput.content, input.mapping, mapping)
          }) as unknown as Promise<Record<string, unknown>>
        ),
      validateAccessTransformer: (atInput) =>
        record(opening["access-transformer"], () =>
          services.validateAccessTransformer(atInput) as unknown as Promise<Record<string, unknown>>
        ),
      discoverMixins: async (path, configPaths) =>
        (discovered.mixins = initialDiscovery?.mixins ?? await discoverWorkspaceMixins(path, configPaths)),
      discoverAccessWideners: async (path) =>
        (discovered["access-wideners"] = initialDiscovery?.["access-wideners"] ?? await discoverWorkspaceAccessWideners(path)),
      discoverAccessTransformers: async (path) =>
        (discovered["access-transformers"] = initialDiscovery?.["access-transformers"] ?? await discoverWorkspaceAccessTransformers(path)),
      detectProjectMinecraftVersion: (path) => services.workspaceMappingService.detectProjectMinecraftVersion(path),
      // Without a namespace the artifact check would assume obfuscated names, so it is skipped.
      ...(mapping !== undefined
        ? { probeMinecraftArtifact: (probe) => services.probeMinecraftArtifact(probe) }
        : {})
    };

    const report = MIXIN_REPORT[input.detail];
    const serviceInput: ValidateProjectInput = {
      task: "project-summary",
      subject: { kind: "workspace", projectPath, discover: [...input.discover] },
      ...defined({ version: input.version, mapping, scope: input.scope }),
      preferProjectMapping: false,
      minSeverity: "all",
      hideUncertain: false,
      explain: report.explain,
      treatInfoAsWarning: true,
      includeIssues: true,
      reportMode: report.reportMode
    };
    let summaryResult: Record<string, unknown> & { warnings?: string[] };
    try {
      summaryResult = await handleProjectSummary(deps, serviceInput, "full", ["workspace"], { stageEmitter });
    } catch (caught) {
      throw catalogServiceError(caught);
    }
    const summary = summaryResult.summary as { status: string; nextActions?: Array<{ tool: string; params: Record<string, unknown> }> };
    // An access file's approximation reasons are stated in its version-mismatch
    // warning, as access-validate states them, so the service's copies are left out.
    const approximationReasons = new Set(
      [...discovered["access-wideners"], ...discovered["access-transformers"]].flatMap(
        (path) => (records.get(path)?.output as AccessFileOutput | undefined)?.approximationReasons ?? []
      )
    );
    const serviceWarnings = (summaryResult.warnings ?? [])
      .filter((warning) => !approximationReasons.has(warning))
      .map(catalogServiceText);
    const tasks = projectTasks(summaryResult.tasks as Record<string, unknown>, input.detail);

    if (summary.status === "blocked") {
      // The project declares no Minecraft version and files were found.
      const nextActions: CatalogNextAction[] = [];
      for (const suggestion of summary.nextActions ?? []) {
        const translated = translateServiceSuggestedCall(suggestion, call.tool);
        if (translated?.tool !== "project-validate") continue;
        nextActions.push({
          tool: "project-validate",
          params: { ...request, ...translated.params, projectPath: input.projectPath },
          reason: "Validate with the project's Minecraft version in place of <minecraft-version>.",
          template: true
        });
      }
      const items = blockedItems(discovered);
      return {
        result: {
          project: {
            status: "blocked",
            counts: itemCountsByStatus(items),
            items,
            tasks,
            ...(input.detail !== "summary" ? { workspace: workspaceBlock(projectPath, discovered) } : {})
          }
        },
        warnings: [...warnings, ...serviceWarnings],
        nextActions
      };
    }

    const followUps = new FollowUps(call.tool);
    const items: ProjectItem[] = [
      ...discovered.mixins.map((path) => mixinConfigItem(path, records.get(path), input.detail, followUps)),
      ...discovered["access-wideners"].map((path) =>
        accessFileItem(path, "access-widener", records.get(path), input.detail)
      ),
      ...discovered["access-transformers"].map((path) =>
        accessFileItem(path, "access-transformer", records.get(path), input.detail)
      )
    ];
    const status = overallStatus(items.map((item) => item.status));
    const accessWarnings = approximationWarnings(
      [...discovered["access-wideners"], ...discovered["access-transformers"]],
      records
    );
    const nextActions =
      input.detail === "summary"
        ? items.some((item) => item.status !== "ok")
          ? [
              {
                tool: "project-validate",
                params: { ...request, detail: "standard" },
                reason: "List each file's issues."
              }
            ]
          : []
        : followUps.list();
    return {
      result: {
        project: {
          status,
          counts: itemCountsByStatus(items),
          items,
          tasks,
          ...(input.detail !== "summary" ? { workspace: workspaceBlock(projectPath, discovered) } : {})
        }
      },
      warnings: [...warnings, ...accessWarnings, ...serviceWarnings],
      nextActions
    };
  }
};

// ---------------------------------------------------------------------------
// access-validate
// ---------------------------------------------------------------------------

const ACCESS_FORMATS = ["access-widener", "access-transformer"] as const;
type AccessFormat = (typeof ACCESS_FORMATS)[number];

/** The namespaces an access file's names can be written in: the mapping namespaces plus SRG (transformers only). */
const ACCESS_MAPPINGS = [...MAPPING_NAMESPACES, "srg"] as const;

/** Namespaces the service of each format accepts. */
const ACCESS_MAPPINGS_BY_FORMAT: Readonly<Record<AccessFormat, readonly string[]>> = {
  "access-widener": MAPPING_NAMESPACES,
  "access-transformer": ["obfuscated", "mojang", "srg"]
};

const accessValidateInput = z
  .strictObject({
    format: z.enum(ACCESS_FORMATS).describe("access-widener (Fabric) or access-transformer (Forge, NeoForge)."),
    content: nonEmptyString.optional().describe("The file's text."),
    path: nonEmptyString.optional().describe("The file to read."),
    version: nonEmptyString.describe("Minecraft version to check against."),
    mapping: z
      .enum(ACCESS_MAPPINGS)
      .describe("Namespace of the file's names; srg: transformers; intermediary, yarn: wideners."),
    projectPath: nonEmptyString.optional().describe("Workspace whose runtime jar to check against."),
    scope: z
      .enum(ARTIFACT_SCOPES)
      .optional()
      .describe("Jar: vanilla, merged or loader; default loader with projectPath, else vanilla.")
  })
  .superRefine((value, ctx) => {
    const given = (["content", "path"] as const).filter((key) => value[key] !== undefined);
    if (given.length === 0) {
      ctx.addIssue({ code: "custom", path: [], message: "Pass exactly one of content, path." });
    } else if (given.length > 1) {
      for (const key of given) {
        ctx.addIssue({ code: "custom", path: [key], message: "Pass exactly one of content, path; this request has both." });
      }
    }
    if (!ACCESS_MAPPINGS_BY_FORMAT[value.format].includes(value.mapping)) {
      ctx.addIssue({
        code: "custom",
        path: ["mapping"],
        message:
          `mapping "${value.mapping}" is not a namespace of format "${value.format}"; ` +
          `it takes ${ACCESS_MAPPINGS_BY_FORMAT[value.format].join(", ")}.`
      });
    }
  });

type AccessValidateInput = z.output<typeof accessValidateInput>;

type AccessOutput = ValidateAccessWidenerOutput | ValidateAccessTransformerOutput;
type AccessEntry = AccessOutput["entries"][number];

/** Reads an access file named by `path`, Windows and WSL spellings converted first. */
async function readAccessFile(format: AccessFormat, rawPath: string): Promise<string> {
  const path = normalizePathForHost(rawPath, undefined, "path");
  try {
    return await readFile(path, "utf8");
  } catch (caught) {
    const osCode = (caught as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    const reason = caught instanceof Error ? caught.message : String(caught);
    const message = `Could not read the ${format.replace("-", " ")} file "${path}": ${osCode} - ${reason}`;
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message,
      details: {
        fieldErrors: [{ path: "path", code: "custom", message }],
        nextAction: `Verify the file exists and is readable at "${path}".`
      }
    });
  }
}

/**
 * The service's warnings that a class name could not be mapped into the
 * jar's namespace, by class: the service then looks the class up by its
 * unmapped name, so a miss says nothing about whether the class exists.
 */
const UNMAPPED_CLASS_WARNINGS: readonly RegExp[] = [
  /^Could not map class "(.+)" from \S+ to \S+\.$/,
  /^Mapping lookup failed for class "(.+)"\.$/
];

function unmappedClasses(warnings: readonly string[]): Map<string, string> {
  const byClass = new Map<string, string>();
  for (const warning of warnings) {
    for (const pattern of UNMAPPED_CLASS_WARNINGS) {
      const match = pattern.exec(warning);
      if (match !== null && !byClass.has(match[1]!)) byClass.set(match[1]!, warning);
    }
  }
  return byClass;
}

/** A service line that names the file line it is about: a rejected line or a broken rule. */
const LINE_WARNING = /^Line \d+: /;

/** The class an entry names, as the service looks it up: a widener's `target`, a transformer's `owner`. */
function entryClass(entry: AccessEntry, format: AccessFormat): string {
  return format === "access-widener" ? entry.target.replace(/\//g, ".") : (entry as { owner: string }).owner;
}

/**
 * Each entry as the service returned it; an entry not found because its
 * class could not be mapped is marked `confidence: "uncertain"` with the
 * service's warning as `confidenceReason`. A rule violation (its issue
 * starts with its line) fails whatever the names are.
 */
function accessEntries(
  output: AccessOutput,
  format: AccessFormat
): Array<AccessEntry & { confidence?: "uncertain"; confidenceReason?: string }> {
  const unmapped = unmappedClasses(output.warnings);
  return output.entries.map((entry) => {
    if (entry.valid !== false || LINE_WARNING.test(entry.issue ?? "")) return entry;
    const reason = unmapped.get(entryClass(entry, format));
    return reason === undefined ? entry : { ...entry, confidence: "uncertain" as const, confidenceReason: reason };
  });
}

/**
 * `invalid` when an entry definitely fails or the file itself is rejected
 * (its header, a malformed line); `partial` when its only failures are
 * uncertain or it was checked against another version's jar; else `ok`.
 */
function accessStatus(output: AccessOutput, entries: ReturnType<typeof accessEntries>): CatalogStatus {
  const failed = entries.filter((entry) => entry.valid === false);
  const definite = failed.filter((entry) => entry.confidence !== "uncertain");
  if (definite.length > 0) return "invalid";
  if (output.valid === false && (failed.length === 0 || output.warnings.some((warning) => LINE_WARNING.test(warning)))) {
    return "invalid";
  }
  if (failed.length > 0 || output.approximate === true) return "partial";
  return "ok";
}

/**
 * Why an invalid access file failed: each definite entry failure as
 * `line <n>: <issue>`, then the lines the service rejected (its header, a
 * malformed line), which are the only reason when no entry failed. Any other
 * warning is not a reason and is reported as a warning only.
 */
function accessErrors(entries: ReturnType<typeof accessEntries>, warnings: readonly string[]): string[] {
  return [
    ...entries.filter((entry) => entry.valid === false && entry.confidence !== "uncertain").map(entryError),
    ...warnings.filter((warning) => LINE_WARNING.test(warning))
  ];
}

export const accessValidateSpec: CatalogToolSpec<AccessValidateInput> = {
  name: "access-validate",
  description:
    "Check an access widener or access transformer against a Minecraft version's bytecode, entry by entry. " +
    "Pass format, exactly one of content or path, version, and mapping (the file's namespace; required, it " +
    "overrides a widener header). scope picks the jar; projectPath defaults it to loader. " +
    'Example: {"format":"access-widener","path":"/p/m.accesswidener","version":"1.21.10","mapping":"intermediary"}',
  annotations: { readOnlyHint: true },
  inputSchema: accessValidateInput,
  examples: [
    {
      format: "access-widener",
      path: "/path/to/project/src/main/resources/example.accesswidener",
      version: "1.21.10",
      mapping: "intermediary"
    },
    {
      format: "access-transformer",
      content: "public net.minecraft.world.entity.Entity tick()V",
      version: "1.21.10",
      mapping: "mojang",
      projectPath: "/path/to/project"
    }
  ],
  statuses: ["ok", "partial", "invalid"],
  primaryKey: "validation",
  handler: async (input, call) => {
    const services = call.services;
    const content = input.content ?? (await readAccessFile(input.format, input.path!));
    const runtime = defined({ projectPath: normalizeOptionalProjectPath(input.projectPath), scope: input.scope });
    let output: AccessOutput;
    try {
      output =
        input.format === "access-widener"
          ? await services.validateAccessWidener({
              content,
              version: input.version,
              mapping: input.mapping as SourceMapping,
              ...runtime
            })
          : await services.validateAccessTransformer({
              content,
              version: input.version,
              atNamespace: input.mapping as AccessTransformerNamespace,
              ...runtime
            });
    } catch (caught) {
      throw catalogServiceError(caught);
    }

    const entries = accessEntries(output, input.format);
    const status = accessStatus(output, entries);
    const approximationReasons = output.approximationReasons ?? [];
    const serviceWarnings = output.warnings
      .filter((warning) => !approximationReasons.includes(warning))
      .map(catalogServiceText);
    // An invalid file says why: its definite entry failures, and the lines
    // the service rejected (its header, a malformed line), which are the only
    // reason when no entry failed. Every other warning stays in meta.warnings.
    const errors = status === "invalid" ? accessErrors(entries, serviceWarnings) : [];
    const warnings: Array<string | CatalogWarning> = [];
    if (output.approximate === true) {
      warnings.push({
        code: "version-mismatch",
        severity: "warning",
        message:
          "The file was checked against another version's runtime jar" +
          (approximationReasons.length > 0 ? `: ${approximationReasons.join(" ")}` : ".")
      });
    }
    const widener = output as Partial<ValidateAccessWidenerOutput>;
    return {
      result: {
        validation: {
          status,
          format: input.format,
          ...(errors.length > 0 ? { errors } : {}),
          ...defined({ headerVersion: widener.headerVersion, namespace: widener.namespace }),
          entries,
          summary: output.summary,
          ...defined({
            provenance: output.provenance,
            approximate: output.approximate,
            approximationReasons: output.approximationReasons
          })
        }
      },
      warnings: [...warnings, ...serviceWarnings]
    };
  }
};

// ---------------------------------------------------------------------------
// mixin-verify-target
// ---------------------------------------------------------------------------

const VERIFY_TARGET_KINDS = ["version", "jar", "coordinate", "workspace", "dependency"] as const;

const mixinVerifyTargetInput = z
  .strictObject({
    target: targetSchema(VERIFY_TARGET_KINDS),
    className: nonEmptyString.describe("Fully qualified class the mixin targets."),
    kind: z.enum(["method", "field"]).describe("Kind of the target member."),
    memberName: nonEmptyString.describe("The member's simple name."),
    descriptor: nonEmptyString.optional().describe('JVM descriptor, e.g. "()V"; omitted: any.'),
    mixinMemberName: nonEmptyString.optional().describe("Your mixin member's name; refines the advice."),
    mapping: mappingSchema.describe("Namespace of className, memberName and descriptor."),
    autoRemap: z.boolean().default(true).describe("Translate the names into the artifact's namespace.")
  })
  .superRefine((value, ctx) => {
    if (NOT_IN_SIMPLE_MEMBER_NAME.test(value.memberName)) {
      ctx.addIssue({ code: "custom", path: ["memberName"], message: SIMPLE_MEMBER_NAME_MESSAGE });
    }
  });

type MixinVerifyTargetInput = z.output<typeof mixinVerifyTargetInput>;

export const mixinVerifyTargetSpec: CatalogToolSpec<MixinVerifyTargetInput> = {
  name: "mixin-verify-target",
  description:
    "Check that a mixin target method or field exists in the jar's bytecode, with @Shadow/@Accessor/@Invoker " +
    "advice. Names are translated to the artifact's namespace (autoRemap). status: ok, ambiguous (overloads; " +
    "add descriptor), not_found. " +
    'Example: {"target":{"kind":"version","version":"1.21.10"},"className":"net.minecraft.world.entity.Entity",' +
    '"kind":"method","memberName":"tick","mapping":"mojang"}',
  annotations: { readOnlyHint: true },
  inputSchema: mixinVerifyTargetInput,
  examples: [
    {
      target: { kind: "version", version: "1.21.10" },
      className: "net.minecraft.world.entity.Entity",
      kind: "method",
      memberName: "tick",
      mapping: "mojang"
    },
    {
      target: { kind: "workspace", projectPath: "/path/to/project" },
      className: "net.minecraft.world.entity.Entity",
      kind: "field",
      memberName: "level",
      mapping: "mojang",
      mixinMemberName: "getLevel"
    }
  ],
  statuses: ["ok", "ambiguous", "not_found"],
  primaryKey: "verdict",
  handler: async (input, call) => {
    const services = call.services;
    const target = input.target as CatalogTarget;
    const request = toResolveArtifactRequest(target);
    // The full resolution, for the artifact block and its warnings, and the
    // member name autoRemap translated, for the verdict.
    let resolved: ResolveArtifactOutput | undefined;
    let translatedMember: { name: string } | undefined;
    const service = new VerifyMixinTargetService({
      resolveArtifact: async (resolveInput) => {
        resolved = await withCatalogFieldPaths(target, () =>
          services.resolveArtifact({
            target: resolveInput.target,
            ...defined({ mapping: resolveInput.mapping, projectPath: resolveInput.projectPath, scope: resolveInput.scope })
          })
        );
        return {
          artifactId: resolved.artifactId,
          mappingApplied: resolved.mappingApplied,
          ...defined({ binaryJarPath: resolved.binaryJarPath, version: resolved.version }),
          provenance: resolved.provenance,
          // Reported with the artifact block instead.
          warnings: []
        };
      },
      findMapping: async (mappingInput) => {
        const output = await services.findMapping({
          version: mappingInput.version,
          kind: mappingInput.kind,
          name: mappingInput.name,
          ...defined({ owner: mappingInput.owner }),
          // A field lookup takes no descriptor; a method's descriptor picks
          // one overload, which the default name-only mode would ignore.
          ...(mappingInput.kind === "method" && mappingInput.descriptor !== undefined
            ? { descriptor: mappingInput.descriptor, signatureMode: "exact" as const }
            : {}),
          sourceMapping: mappingInput.sourceMapping,
          targetMapping: mappingInput.targetMapping
        });
        const symbol = output.resolvedSymbol;
        if (mappingInput.kind !== "class" && output.resolved && symbol !== undefined) {
          translatedMember = { name: symbol.name };
        }
        return {
          resolved: output.resolved,
          ...(symbol !== undefined
            ? { resolvedSymbol: { name: symbol.name, ...defined({ owner: symbol.owner, descriptor: symbol.descriptor }) } }
            : {})
        };
      },
      getSignature: (signatureInput) => services.explorerService.getSignature(signatureInput)
    });

    let output: Awaited<ReturnType<VerifyMixinTargetService["execute"]>>;
    try {
      output = await service.execute({
        owner: input.className,
        member: { kind: input.kind, name: input.memberName, ...defined({ descriptor: input.descriptor }) },
        ...defined({ mixinMemberName: input.mixinMemberName }),
        mapping: input.mapping,
        autoRemap: input.autoRemap,
        target: request.target,
        ...defined({ projectPath: request.projectPath, scope: request.scope })
      });
    } catch (caught) {
      throw catalogServiceError(caught);
    }

    const described = describeResolvedArtifact(resolved!);
    const memberName = translatedMember?.name ?? input.memberName;
    const status: CatalogStatus =
      output.matches.length === 1 ? "ok" : output.matches.length > 1 ? "ambiguous" : "not_found";
    const nextActions: CatalogNextAction[] = [];
    if (status === "ambiguous") {
      // The matches' descriptors are in the artifact's namespace, so a call
      // whose names were translated asks again in that namespace.
      const translated = translatedMember !== undefined;
      nextActions.push({
        tool: "mixin-verify-target",
        params: {
          target: input.target,
          className: translated ? output.resolvedOwner.className : input.className,
          kind: input.kind,
          memberName,
          descriptor: "<descriptor>",
          mapping: translated ? resolved!.mappingApplied : input.mapping,
          ...defined({ mixinMemberName: input.mixinMemberName })
        },
        reason: "Verify one overload: put one of verdict.matches[].descriptor in place of <descriptor>.",
        template: true
      });
    }
    return {
      result: {
        verdict: {
          status,
          className: output.resolvedOwner.className,
          kind: input.kind,
          memberName,
          mapping: output.resolvedOwner.mapping,
          matches: output.matches,
          candidates: output.candidates,
          ...defined({ advice: output.accessorAdvice })
        },
        artifact: described.artifact
      },
      warnings: [...described.warnings, ...output.warnings],
      nextActions
    };
  }
};

export const VALIDATION_TOOL_SPECS: readonly CatalogToolSpec[] = [
  projectValidateSpec,
  mixinValidateSpec,
  accessValidateSpec,
  mixinVerifyTargetSpec
];
