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

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "candidates", "matrix", "workspace", "timings"] as const;
const TASKS = ["exists", "map", "exact-map", "lifecycle", "workspace", "api-overview"] as const;

export const analyzeSymbolShape = {
  task: z.enum(TASKS),
  subject: z.object({
    kind: z.enum(["class", "method", "field", "symbol"]),
    name: nonEmptyString,
    owner: nonEmptyString.optional(),
    descriptor: nonEmptyString.optional()
  }),
  version: nonEmptyString.optional(),
  sourceMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  targetMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  classNameMapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  projectPath: nonEmptyString.optional(),
  signatureMode: z.enum(["exact", "name-only"]).default("exact"),
  nameMode: z.enum(["fqcn", "auto"]).default("fqcn"),
  includeKinds: z.array(z.enum(["class", "field", "method"])).optional(),
  maxRows: positiveIntSchema.optional(),
  maxCandidates: positiveIntSchema.default(200),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS)
};

export const analyzeSymbolSchema = z.object(analyzeSymbolShape).superRefine((value, ctx) => {
  if (value.task !== "workspace" && !value.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message: "version is required for non-workspace tasks."
    });
  }
  if (value.task === "workspace" && !value.projectPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectPath"],
      message: "projectPath is required for task=workspace."
    });
  }
  if (value.task === "api-overview" && value.subject.kind !== "class") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=api-overview requires subject.kind=class."
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
    maxCandidates?: number;
  }) => Promise<ResolveMethodMappingExactOutput>;
  traceSymbolLifecycle: (input: {
    symbol: string;
    descriptor?: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
  }) => Promise<TraceSymbolLifecycleOutput>;
  resolveWorkspaceSymbol: (input: {
    projectPath: string;
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    maxCandidates?: number;
  }) => Promise<ResolveWorkspaceSymbolOutput>;
  getClassApiMatrix: (input: {
    version: string;
    className: string;
    classNameMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    includeKinds?: ("class" | "field" | "method")[];
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
    const subjectKind = input.subject.kind === "symbol"
      ? "class"
      : input.subject.kind;

    switch (input.task) {
      case "exists": {
        const output = await this.deps.checkSymbolExists({
          version: input.version!,
          kind: subjectKind,
          name: input.subject.name,
          owner: input.subject.owner,
          descriptor: input.subject.descriptor,
          sourceMapping: input.sourceMapping ?? "obfuscated",
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
                kind: input.subject.kind,
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
              candidates: output.candidates,
              ambiguity: output.ambiguityReasons ? { reasons: output.ambiguityReasons } : undefined
            }
          }),
          warnings: output.warnings
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
                kind: input.subject.kind,
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
              candidates: output.candidates,
              ambiguity: output.ambiguityReasons ? { reasons: output.ambiguityReasons } : undefined
            }
          }),
          warnings: output.warnings
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
                kind: input.subject.kind,
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
              candidates: output.candidates
            }
          }),
          warnings: output.warnings
        };
      }
      case "lifecycle": {
        const output = await this.deps.traceSymbolLifecycle({
          symbol: input.subject.owner
            ? `${input.subject.owner}.${input.subject.name}`
            : input.subject.name,
          descriptor: input.subject.descriptor,
          mapping: input.sourceMapping
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
                kind: input.subject.kind,
                name: input.subject.name,
                owner: input.subject.owner,
                descriptor: input.subject.descriptor,
                version: input.version,
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
          warnings: output.warnings
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
                kind: input.subject.kind,
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
              candidates: output.candidates,
              workspace: output.workspaceDetection
            }
          }),
          warnings: [...output.warnings, ...output.workspaceDetection.warnings]
        };
      }
      case "api-overview": {
        const classNameMapping = input.classNameMapping ?? input.sourceMapping ?? "obfuscated";
        const output = await this.deps.getClassApiMatrix({
          version: input.version!,
          className: input.subject.name,
          classNameMapping,
          includeKinds: input.includeKinds,
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
                kind: input.subject.kind,
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
          warnings: output.warnings
        };
      }
    }
  }
}
