import { z } from "zod";

import { createError, ERROR_CODES } from "../errors.js";
import type {
  CheckSymbolExistsOutput,
  FindMappingOutput,
  GetClassApiMatrixOutput,
  ResolveMethodMappingExactOutput,
  ResolveWorkspaceSymbolOutput,
  TraceSymbolLifecycleOutput
} from "../source-service.js";
import { buildIncludeSchema, detailSchema, positiveIntSchema } from "./entry-tool-schema.js";
import {
  buildEntryToolResult,
  createSummarySubject,
  type DetailLevel,
  type Summary
} from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";
import { compactMappingResponse } from "../response-utils.js";

const nonEmptyString = z.string().trim().min(1);

/**
 * Reuse the expert-tool compactMappingResponse candidate projection so the entry
 * tool is as terse as the low-level one: drop the lone exact candidate that just
 * duplicates `match` (resolved-exact), and slim the tail of unresolved candidate
 * lists. Returns block fields to spread into buildEntryToolResult's `blocks`.
 */
function projectMappingCandidates(output: { candidates?: unknown }): {
  candidates: unknown;
  candidateDetailsTruncated?: boolean;
} {
  const projected = compactMappingResponse(output as unknown as Record<string, unknown>);
  return {
    candidates: projected.candidates,
    ...(projected.candidateDetailsTruncated === true ? { candidateDetailsTruncated: true } : {})
  };
}
// Descriptor field that treats empty/whitespace strings as omitted so callers can pass
// `descriptor: ""` interchangeably with omitting the field when signatureMode="name-only".
const optionalDescriptorString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });
/**
 * Resolve subject.kind to a concrete kind. `"symbol"` is auto-detected from the
 * selector (owner+descriptor => method, owner only => field, otherwise => class)
 * and the inference is surfaced as a warning so the caller can see what ran.
 */
function inferSubjectKind(subject: {
  kind: "class" | "method" | "field" | "symbol";
  owner?: string;
  descriptor?: string;
}): { kind: "class" | "field" | "method"; warning?: string } {
  if (subject.kind !== "symbol") {
    return { kind: subject.kind };
  }
  let inferred: "class" | "field" | "method";
  if (subject.owner && subject.descriptor) {
    inferred = "method";
  } else if (subject.owner) {
    inferred = "field";
  } else {
    inferred = "class";
  }
  const selectorNote = subject.owner
    ? subject.descriptor
      ? "owner+descriptor"
      : "owner only"
    : "no owner/descriptor";
  return {
    kind: inferred,
    warning: `subject.kind="symbol" was auto-detected as "${inferred}" (${selectorNote}). Pass an explicit kind to override.`
  };
}

const INCLUDE_GROUPS = ["warnings", "candidates", "matrix", "workspace", "timings"] as const;
const TASKS = ["exists", "map", "exact-map", "lifecycle", "workspace", "api-overview"] as const;

export const analyzeSymbolShape = {
  task: z.enum(TASKS),
  subject: z.object({
    kind: z
      .enum(["class", "method", "field", "symbol"])
      .describe(
        "Symbol kind. Use 'symbol' to auto-detect from the selector: owner+descriptor => method, owner only => field, otherwise => class. The inferred kind is reported as a warning. For task=api-overview the inferred kind must be class."
      ),
    name: nonEmptyString,
    owner: nonEmptyString.optional(),
    descriptor: optionalDescriptorString
  }),
  version: nonEmptyString
    .optional()
    .describe(
      "Point-in-time MC version for task=exists/map/exact-map/api-overview. For task=lifecycle it is accepted as a back-compat alias for toVersion (range end)."
    ),
  fromVersion: nonEmptyString
    .optional()
    .describe("task=lifecycle only: range start (oldest) version; defaults to the oldest version in the manifest."),
  toVersion: nonEmptyString
    .optional()
    .describe("task=lifecycle only: range end (newest) version; takes precedence over version. Defaults to latest."),
  maxVersions: positiveIntSchema
    .max(400)
    .optional()
    .describe("task=lifecycle only: cap on scanned versions (service default 120, max 400)."),
  includeTimeline: z
    .boolean()
    .optional()
    .describe("task=lifecycle only: include per-version timeline entries."),
  includeSnapshots: z
    .boolean()
    .optional()
    .describe("task=lifecycle only: include snapshot versions in the scan."),
  sourceMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  targetMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  classNameMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  projectPath: nonEmptyString.optional(),
  gradleUserHome: nonEmptyString.optional(),
  signatureMode: z.enum(["exact", "name-only"]).default("exact"),
  nameMode: z.enum(["fqcn", "auto"]).default("auto"),
  includeKinds: z.array(z.enum(["class", "field", "method"])).optional(),
  maxRows: positiveIntSchema.optional(),
  maxCandidates: positiveIntSchema.default(5),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS)
};

const LIFECYCLE_ONLY_FIELDS = [
  "fromVersion",
  "toVersion",
  "maxVersions",
  "includeTimeline",
  "includeSnapshots"
] as const;

export const analyzeSymbolSchema = z.object(analyzeSymbolShape).superRefine((value, ctx) => {
  if (value.task !== "workspace" && value.task !== "lifecycle" && !value.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message: "version is required for non-workspace tasks."
    });
  }
  if (value.task === "lifecycle" && !value.version && !value.toVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toVersion"],
      message: "task=lifecycle requires toVersion (or version as a back-compat alias) as the range end."
    });
  }
  if (value.task !== "lifecycle") {
    for (const field of LIFECYCLE_ONLY_FIELDS) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only supported for task=lifecycle.`
        });
      }
    }
  }
  if (value.task === "workspace" && !value.projectPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectPath"],
      message: "projectPath is required for task=workspace."
    });
  }
  if (
    value.task === "api-overview" &&
    value.subject.kind !== "class" &&
    value.subject.kind !== "symbol"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=api-overview requires subject.kind=class (or 'symbol', which infers class)."
    });
  }
  if (value.task === "api-overview" && value.subject.owner) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "owner"],
      message: "task=api-overview does not accept owner or descriptor selectors."
    });
  }
  if (value.task === "api-overview" && value.subject.descriptor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "descriptor"],
      message: "task=api-overview does not accept owner or descriptor selectors."
    });
  }
});

export type AnalyzeSymbolInput = z.infer<typeof analyzeSymbolSchema>;

type AnalyzeSymbolDeps = {
  checkSymbolExists: (input: {
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    gradleUserHome?: string;
    nameMode?: "fqcn" | "auto";
    signatureMode?: "exact" | "name-only";
    maxCandidates?: number;
  }) => Promise<CheckSymbolExistsOutput>;
  findMapping: (input: {
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    gradleUserHome?: string;
    nameMode?: "fqcn" | "auto";
    signatureMode?: "exact" | "name-only";
    maxCandidates?: number;
  }) => Promise<FindMappingOutput>;
  resolveMethodMappingExact: (input: {
    version: string;
    owner: string;
    name: string;
    descriptor: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    gradleUserHome?: string;
    maxCandidates?: number;
  }) => Promise<ResolveMethodMappingExactOutput>;
  traceSymbolLifecycle: (input: {
    symbol: string;
    descriptor?: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    gradleUserHome?: string;
    fromVersion?: string;
    toVersion?: string;
    maxVersions?: number;
    includeSnapshots?: boolean;
    includeTimeline?: boolean;
  }) => Promise<TraceSymbolLifecycleOutput>;
  resolveWorkspaceSymbol: (input: {
    projectPath: string;
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    gradleUserHome?: string;
    maxCandidates?: number;
  }) => Promise<ResolveWorkspaceSymbolOutput>;
  getClassApiMatrix: (input: {
    version: string;
    className: string;
    classNameMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    includeKinds?: ("class" | "field" | "method")[];
    gradleUserHome?: string;
    maxRows?: number;
  }) => Promise<GetClassApiMatrixOutput>;
};

function summaryStatusFromResolution(
  status: "resolved" | "not_found" | "ambiguous" | "mapping_unavailable"
): Summary["status"] {
  switch (status) {
    case "resolved":
      return "ok";
    case "not_found":
      return "not_found";
    case "ambiguous":
      return "ambiguous";
    case "mapping_unavailable":
      return "partial";
  }
}

export class AnalyzeSymbolService {
  constructor(private readonly deps: AnalyzeSymbolDeps) {}

  async execute(input: AnalyzeSymbolInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);
    const { kind: subjectKind, warning: inferenceWarning } = inferSubjectKind(input.subject);

    switch (input.task) {
      case "exists": {
        const output = await this.deps.checkSymbolExists({
          version: input.version!,
          kind: subjectKind,
          name: input.subject.name,
          owner: input.subject.owner,
          descriptor: input.subject.descriptor,
          sourceMapping: input.sourceMapping ?? "obfuscated",
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          nameMode: input.nameMode,
          signatureMode: input.signatureMode,
          maxCandidates: input.maxCandidates
        });
        return {
          ...buildEntryToolResult({
            task: "exists",
            detail,
            include,
            summary: {
              status: summaryStatusFromResolution(output.status),
              headline: output.resolved
                ? `The symbol exists in ${output.mappingContext.version}.`
                : `The symbol could not be resolved in ${output.mappingContext.version}.`,
              subject: createSummarySubject({
                task: "exists",
                kind: subjectKind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                version: input.version,
                sourceMapping: input.sourceMapping ?? "obfuscated"
              }),
              counts: {
                candidates: output.candidateCount
              }
            },
            blocks: {
              match: output.resolvedSymbol ?? output.querySymbol,
              ...projectMappingCandidates(output),
              ambiguity: output.ambiguityReasons ? { reasons: output.ambiguityReasons } : undefined
            }
          }),
          warnings: inferenceWarning ? [inferenceWarning, ...output.warnings] : output.warnings
        };
      }
      case "map": {
        const output = await this.deps.findMapping({
          version: input.version!,
          kind: subjectKind,
          name: input.subject.name,
          owner: input.subject.owner,
          descriptor: input.subject.descriptor,
          sourceMapping: input.sourceMapping ?? "obfuscated",
          targetMapping: input.targetMapping ?? "mojang",
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          nameMode: input.nameMode,
          signatureMode: input.signatureMode,
          maxCandidates: input.maxCandidates
        });
        return {
          ...buildEntryToolResult({
            task: "map",
            detail,
            include,
            summary: {
              status: summaryStatusFromResolution(output.status),
              headline: output.resolved
                ? `Mapped the symbol into ${output.mappingContext.targetMapping}.`
                : `Found ${output.candidateCount} candidate mappings.`,
              subject: createSummarySubject({
                task: "map",
                kind: subjectKind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                version: input.version,
                sourceMapping: input.sourceMapping ?? "obfuscated",
                targetMapping: input.targetMapping ?? "mojang"
              }),
              counts: {
                candidates: output.candidateCount
              }
            },
            blocks: {
              match: output.resolvedSymbol,
              ...projectMappingCandidates(output),
              ambiguity: output.ambiguityReasons ? { reasons: output.ambiguityReasons } : undefined
            }
          }),
          warnings: inferenceWarning ? [inferenceWarning, ...output.warnings] : output.warnings
        };
      }
      case "exact-map": {
        if (!input.subject.owner || !input.subject.descriptor) {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "task=exact-map requires owner and descriptor."
          });
        }
        const output = await this.deps.resolveMethodMappingExact({
          version: input.version!,
          owner: input.subject.owner,
          name: input.subject.name,
          descriptor: input.subject.descriptor,
          sourceMapping: input.sourceMapping ?? "obfuscated",
          targetMapping: input.targetMapping ?? "mojang",
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          maxCandidates: input.maxCandidates
        });
        return {
          ...buildEntryToolResult({
            task: "exact-map",
            detail,
            include,
            summary: {
              status: summaryStatusFromResolution(output.status),
              headline: output.resolved
                ? "Resolved the exact method mapping."
                : "Could not resolve the exact method mapping.",
              subject: createSummarySubject({
                task: "exact-map",
                kind: subjectKind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                version: input.version,
                sourceMapping: input.sourceMapping ?? "obfuscated",
                targetMapping: input.targetMapping ?? "mojang"
              }),
              counts: {
                candidates: output.candidateCount
              }
            },
            blocks: {
              match: output.resolvedSymbol,
              ...projectMappingCandidates(output)
            }
          }),
          warnings: inferenceWarning ? [inferenceWarning, ...output.warnings] : output.warnings
        };
      }
      case "lifecycle": {
        const output = await this.deps.traceSymbolLifecycle({
          symbol: input.subject.owner
            ? `${input.subject.owner}.${input.subject.name}`
            : input.subject.name,
          descriptor: input.subject.descriptor,
          mapping: input.sourceMapping,
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          ...(input.fromVersion !== undefined ? { fromVersion: input.fromVersion } : {}),
          toVersion: input.toVersion ?? input.version,
          ...(input.maxVersions !== undefined ? { maxVersions: input.maxVersions } : {}),
          ...(input.includeSnapshots !== undefined ? { includeSnapshots: input.includeSnapshots } : {}),
          ...(input.includeTimeline !== undefined ? { includeTimeline: input.includeTimeline } : {})
        });
        return {
          ...buildEntryToolResult({
            task: "lifecycle",
            detail,
            include,
            summary: {
              status: output.presence.firstSeen ? "ok" : "not_found",
              headline: output.presence.firstSeen
                ? `Tracked the symbol from ${output.range.fromVersion} to ${output.range.toVersion}.`
                : "The symbol was not found in the scanned version range.",
              subject: createSummarySubject({
                task: "lifecycle",
                kind: subjectKind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                version: input.toVersion ?? input.version,
                sourceMapping: input.sourceMapping ?? "obfuscated"
              }),
              counts: {
                scannedVersions: output.range.scannedCount
              }
            },
            blocks: {
              match: output.query,
              timeline: output.timeline
            }
          }),
          warnings: inferenceWarning ? [inferenceWarning, ...output.warnings] : output.warnings
        };
      }
      case "workspace": {
        const output = await this.deps.resolveWorkspaceSymbol({
          projectPath: input.projectPath!,
          version: input.version ?? "unknown",
          kind: subjectKind,
          name: input.subject.name,
          owner: input.subject.owner,
          descriptor: input.subject.descriptor,
          sourceMapping: input.sourceMapping ?? "obfuscated",
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          maxCandidates: input.maxCandidates
        });
        return {
          ...buildEntryToolResult({
            task: "workspace",
            detail,
            include,
            summary: {
              status: summaryStatusFromResolution(output.status),
              headline: output.workspaceDetection.resolved
                ? `Resolved compile-visible symbol using ${output.workspaceDetection.mappingApplied} workspace mappings.`
                : "Workspace compile mapping could not be detected confidently.",
              subject: createSummarySubject({
                task: "workspace",
                kind: subjectKind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                projectPath: input.projectPath,
                version: input.version ?? "unknown",
                sourceMapping: input.sourceMapping ?? "obfuscated"
              }),
              counts: {
                candidates: output.candidateCount
              }
            },
            blocks: {
              match: output.resolvedSymbol,
              ...projectMappingCandidates(output),
              workspace: output.workspaceDetection
            }
          }),
          warnings: inferenceWarning
            ? [inferenceWarning, ...output.warnings, ...output.workspaceDetection.warnings]
            : [...output.warnings, ...output.workspaceDetection.warnings]
        };
      }
      case "api-overview": {
        const classNameMapping = input.classNameMapping ?? input.sourceMapping ?? "obfuscated";
        const output = await this.deps.getClassApiMatrix({
          version: input.version!,
          className: input.subject.name,
          classNameMapping,
          includeKinds: input.includeKinds,
          ...(input.gradleUserHome !== undefined ? { gradleUserHome: input.gradleUserHome } : {}),
          maxRows: input.maxRows
        });
        return {
          ...buildEntryToolResult({
            task: "api-overview",
            detail,
            include,
            summary: {
              status: "ok",
              headline: `Built an API overview for ${output.className}.`,
              subject: createSummarySubject({
                task: "api-overview",
                kind: subjectKind,
                name: input.subject.name,
                version: input.version,
                classNameMapping
              }),
              counts: {
                rows: output.rowCount,
                ambiguousRows: output.ambiguousRowCount ?? 0
              }
            },
            blocks: {
              match: {
                className: output.className,
                classIdentity: output.classIdentity
              },
              matrix: include.includes("matrix") || detail !== "summary"
                ? {
                    rowCount: output.rowCount,
                    rowsTruncated: output.rowsTruncated,
                    rows: output.rows.slice(0, 25)
                  }
                : undefined
            }
          }),
          warnings: inferenceWarning ? [inferenceWarning, ...output.warnings] : output.warnings
        };
      }
    }
  }
}
