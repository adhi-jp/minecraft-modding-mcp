import { z } from "zod";

import type { DiffClassSignaturesOutput } from "../source-service.js";
import type { CompareVersionsOutput } from "../version-diff-service.js";
import type { GetRegistryDataOutput } from "../registry-service.js";
import { createError, ERROR_CODES } from "../errors.js";
import { buildIncludeSchema, detailSchema, positiveIntSchema } from "./entry-tool-schema.js";
import {
  buildEntryToolMeta,
  buildEntryToolResult,
  createNextAction,
  createSummarySubject,
  createTruncationMeta,
  type Summary
} from "./response-contract.js";
import { capArray, resolveDetail, resolveInclude } from "./request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "classes", "registry", "diff", "samples", "timings"] as const;

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("version-pair"),
    fromVersion: nonEmptyString,
    toVersion: nonEmptyString,
    packageFilter: nonEmptyString.optional()
  }),
  z.object({
    kind: z.literal("class"),
    className: nonEmptyString,
    fromVersion: nonEmptyString,
    toVersion: nonEmptyString,
    mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
    sourcePriority: z.enum(["loom-first", "maven-first"]).optional()
  }),
  z.object({
    kind: z.literal("registry"),
    fromVersion: nonEmptyString,
    toVersion: nonEmptyString,
    registry: nonEmptyString.optional()
  })
]);

export const compareMinecraftShape = {
  task: z.enum(["auto", "versions", "class-diff", "registry-diff", "migration-overview"]).optional(),
  subject: subjectSchema,
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS),
  limit: positiveIntSchema.optional(),
  maxClassResults: positiveIntSchema.default(500),
  maxEntriesPerRegistry: positiveIntSchema.optional(),
  includeFullDiff: z.boolean().default(true)
};

export const compareMinecraftSchema = z.object(compareMinecraftShape);

export type CompareMinecraftInput = z.infer<typeof compareMinecraftSchema>;

type CompareMinecraftDeps = {
  compareVersions: (input: {
    fromVersion: string;
    toVersion: string;
    category?: "classes" | "registry" | "all";
    packageFilter?: string;
    maxClassResults?: number;
  }) => Promise<CompareVersionsOutput>;
  diffClassSignatures: (input: {
    className: string;
    fromVersion: string;
    toVersion: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    includeFullDiff?: boolean;
  }) => Promise<DiffClassSignaturesOutput>;
  getRegistryData: (input: {
    version: string;
    registry?: string;
    includeData?: boolean;
    maxEntriesPerRegistry?: number;
  }) => Promise<GetRegistryDataOutput>;
};

function compareStatusFromCounts(changedCount: number): Summary["status"] {
  return changedCount > 0 ? "changed" : "unchanged";
}

export class CompareMinecraftService {
  constructor(private readonly deps: CompareMinecraftDeps) {}

  async execute(input: CompareMinecraftInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const task = input.task && input.task !== "auto"
      ? input.task
      : input.subject.kind === "class"
        ? "class-diff"
        : input.subject.kind === "registry"
          ? "registry-diff"
          : "versions";
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);

    switch (task) {
      case "versions": {
        const subject = input.subject.kind === "version-pair"
          ? input.subject
          : {
              fromVersion: input.subject.fromVersion,
              toVersion: input.subject.toVersion,
              packageFilter: input.subject.kind === "class" ? undefined : input.subject.registry
            };
        const output = await this.deps.compareVersions({
          fromVersion: subject.fromVersion,
          toVersion: subject.toVersion,
          category: "all",
          packageFilter: subject.packageFilter,
          maxClassResults: input.maxClassResults
        });
        const changedCount =
          (output.classes?.addedCount ?? 0) +
          (output.classes?.removedCount ?? 0) +
          (output.registry?.summary.registriesChanged ?? 0);
        const classSamples = capArray(output.classes?.added ?? [], 5);
        const newRegistries = capArray(output.registry?.newRegistries ?? [], 5);
        const removedRegistries = capArray(output.registry?.removedRegistries ?? [], 5);
        const truncatedGroups = [
          ...(classSamples.truncated ? ["classes"] : []),
          ...(newRegistries.truncated || removedRegistries.truncated ? ["registry"] : [])
        ];
        const summaryTruncatedGroups = detail === "summary"
          ? truncatedGroups.filter((group) => !include.includes(group))
          : [];
        return {
          ...buildEntryToolResult({
            task: "versions",
            detail,
            include,
            summary: {
              status: compareStatusFromCounts(changedCount),
              headline: `Compared ${output.fromVersion} to ${output.toVersion}.`,
              subject: createSummarySubject({
                task: "versions",
                kind: input.subject.kind,
                fromVersion: input.subject.fromVersion,
                toVersion: input.subject.toVersion,
                packageFilter: "packageFilter" in input.subject ? input.subject.packageFilter : undefined,
                registry: input.subject.kind === "registry" ? input.subject.registry : undefined
              }),
              counts: {
                addedClasses: output.classes?.addedCount ?? 0,
                removedClasses: output.classes?.removedCount ?? 0,
                changedRegistries: output.registry?.summary.registriesChanged ?? 0
              }
            },
            blocks: {
              comparison: {
                fromVersion: output.fromVersion,
                toVersion: output.toVersion
              },
              classes: include.includes("classes") || detail !== "summary"
                ? {
                    addedCount: output.classes?.addedCount ?? 0,
                    removedCount: output.classes?.removedCount ?? 0,
                    unchanged: output.classes?.unchanged ?? 0,
                    added: output.classes?.added ?? [],
                    removed: output.classes?.removed ?? []
                  }
                : {
                    addedCount: output.classes?.addedCount ?? 0,
                    removedCount: output.classes?.removedCount ?? 0,
                    unchanged: output.classes?.unchanged ?? 0,
                    sampleAdded: classSamples.items
                  },
              registry: output.registry
                ? {
                    summary: output.registry.summary,
                    newRegistries: include.includes("registry") || detail !== "summary"
                      ? output.registry.newRegistries
                      : newRegistries.items,
                    removedRegistries: include.includes("registry") || detail !== "summary"
                      ? output.registry.removedRegistries
                      : removedRegistries.items
                  }
                : undefined
            }
          }),
          warnings: output.warnings,
          ...(summaryTruncatedGroups.length > 0
            ? {
                meta: buildEntryToolMeta({
                  detail,
                  include,
                  warnings: output.warnings,
                  truncated: createTruncationMeta({
                    omittedGroups: summaryTruncatedGroups,
                    nextActions: [
                      createNextAction("compare-minecraft", {
                        task: "versions",
                        detail: "standard",
                        include: resolveInclude([...include, ...summaryTruncatedGroups]),
                        subject: input.subject
                      })
                    ]
                  })
                })
              }
            : {})
        };
      }
      case "class-diff": {
        if (input.subject.kind !== "class") {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "task=class-diff requires subject.kind=class."
          });
        }
        const output = await this.deps.diffClassSignatures({
          className: input.subject.className,
          fromVersion: input.subject.fromVersion,
          toVersion: input.subject.toVersion,
          mapping: input.subject.mapping,
          sourcePriority: input.subject.sourcePriority,
          includeFullDiff: input.includeFullDiff
        });
        const changedCount =
          output.summary.total.added +
          output.summary.total.removed +
          output.summary.total.modified;
        return {
          ...buildEntryToolResult({
            task: "class-diff",
            detail,
            include,
            summary: {
              status: compareStatusFromCounts(changedCount),
              headline: `Compared ${output.query.className} between ${output.range.fromVersion} and ${output.range.toVersion}.`,
              subject: createSummarySubject({
                task: "class-diff",
                kind: "class",
                className: input.subject.className,
                fromVersion: input.subject.fromVersion,
                toVersion: input.subject.toVersion,
                mapping: input.subject.mapping,
                sourcePriority: input.subject.sourcePriority
              }),
              counts: output.summary.total
            },
            blocks: {
              comparison: output.query,
              classDiff: include.includes("diff") || detail !== "summary"
                ? {
                    classChange: output.classChange,
                    summary: output.summary,
                    constructors: output.constructors,
                    methods: output.methods,
                    fields: output.fields
                  }
                : {
                    classChange: output.classChange,
                    summary: output.summary
                  }
            }
          }),
          warnings: output.warnings
        };
      }
      case "registry-diff": {
        const subject = input.subject.kind === "registry"
          ? input.subject
          : {
              fromVersion: input.subject.fromVersion,
              toVersion: input.subject.toVersion,
              registry: undefined
            };
        const compare = await this.deps.compareVersions({
          fromVersion: subject.fromVersion,
          toVersion: subject.toVersion,
          category: "registry"
        });
        const warnings = [...compare.warnings];
        const registrySummary = compare.registry?.summary ?? {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        };
        let entries:
          | {
              from?: GetRegistryDataOutput;
              to?: GetRegistryDataOutput;
            }
          | undefined;

        if ((include.includes("registry") || detail === "full") && subject.registry) {
          const [fromData, toData] = await Promise.allSettled([
            this.deps.getRegistryData({
              version: subject.fromVersion,
              registry: subject.registry,
              includeData: true,
              maxEntriesPerRegistry: input.maxEntriesPerRegistry
            }),
            this.deps.getRegistryData({
              version: subject.toVersion,
              registry: subject.registry,
              includeData: true,
              maxEntriesPerRegistry: input.maxEntriesPerRegistry
            })
          ]);
          entries = {
            from: fromData.status === "fulfilled" ? fromData.value : undefined,
            to: toData.status === "fulfilled" ? toData.value : undefined
          };
          if (fromData.status === "fulfilled") {
            warnings.push(...fromData.value.warnings);
          } else {
            warnings.push(
              `Could not load ${subject.registry} registry details for ${subject.fromVersion}: ${
                fromData.reason instanceof Error ? fromData.reason.message : String(fromData.reason)
              }`
            );
          }
          if (toData.status === "fulfilled") {
            warnings.push(...toData.value.warnings);
          } else {
            warnings.push(
              `Could not load ${subject.registry} registry details for ${subject.toVersion}: ${
                toData.reason instanceof Error ? toData.reason.message : String(toData.reason)
              }`
            );
          }
        }
        const partialDetail =
          Boolean(subject.registry) &&
          (include.includes("registry") || detail === "full") &&
          entries !== undefined &&
          (!entries.from || !entries.to);
        const missingFromDetail = partialDetail && entries != null && !entries.from;
        const missingToDetail = partialDetail && entries != null && !entries.to;
        const summary: Summary = {
          status: partialDetail ? "partial" : compareStatusFromCounts(registrySummary.registriesChanged),
          headline: partialDetail
            ? `Compared registry changes between ${subject.fromVersion} and ${subject.toVersion} with partial detail.`
            : `Compared registry changes between ${subject.fromVersion} and ${subject.toVersion}.`,
          subject: createSummarySubject({
            task: "registry-diff",
            kind: "registry",
            fromVersion: subject.fromVersion,
            toVersion: subject.toVersion,
            registry: subject.registry
          }),
          counts: {
            changedRegistries: registrySummary.registriesChanged,
            addedEntries: registrySummary.totalAdded,
            removedEntries: registrySummary.totalRemoved
          },
          ...(partialDetail
            ? {
                nextActions: [
                  ...(missingFromDetail
                    ? [{
                        tool: "get-registry-data",
                        params: {
                          version: subject.fromVersion,
                          registry: subject.registry,
                          includeData: true,
                          maxEntriesPerRegistry: input.maxEntriesPerRegistry
                        }
                      }]
                    : []),
                  ...(missingToDetail
                    ? [{
                        tool: "get-registry-data",
                        params: {
                          version: subject.toVersion,
                          registry: subject.registry,
                          includeData: true,
                          maxEntriesPerRegistry: input.maxEntriesPerRegistry
                        }
                      }]
                    : [])
                ]
              }
            : {})
        };
        return {
          ...buildEntryToolResult({
            task: "registry-diff",
            detail,
            include,
            summary,
            blocks: {
              comparison: {
                fromVersion: subject.fromVersion,
                toVersion: subject.toVersion,
                registry: subject.registry
              },
              registry: {
                summary: registrySummary,
                entries
              }
            }
          }),
          warnings
        };
      }
      case "migration-overview": {
        const subject = input.subject.kind === "version-pair"
          ? input.subject
          : {
              fromVersion: input.subject.fromVersion,
              toVersion: input.subject.toVersion
            };
        const compare = await this.deps.compareVersions({
          fromVersion: subject.fromVersion,
          toVersion: subject.toVersion,
          category: "all",
          maxClassResults: input.maxClassResults
        });
        const classSignals = (compare.classes?.addedCount ?? 0) + (compare.classes?.removedCount ?? 0);
        const registrySignals = compare.registry?.summary.registriesChanged ?? 0;
        const status = compareStatusFromCounts(classSignals + registrySignals);
        const representativeClassName = compare.classes?.added[0] ?? compare.classes?.removed[0];
        const nextActions = representativeClassName
          ? [
              createNextAction("compare-minecraft", {
                task: "class-diff",
                subject: {
                  kind: "class",
                  className: representativeClassName,
                  fromVersion: subject.fromVersion,
                  toVersion: subject.toVersion
                }
              })
            ]
          : [
              createNextAction("inspect-minecraft", {
                task: "artifact",
                subject: {
                  kind: "version",
                  version: subject.toVersion
                }
              })
            ];
        return {
          ...buildEntryToolResult({
            task: "migration-overview",
            detail,
            include,
            summary: {
              status,
              headline: `Summarized migration impact from ${subject.fromVersion} to ${subject.toVersion}.`,
              subject: createSummarySubject({
                task: "migration-overview",
                kind: "version-pair",
                fromVersion: subject.fromVersion,
                toVersion: subject.toVersion
              }),
              counts: {
                classSignals,
                registrySignals
              },
              nextActions
            },
            blocks: {
              comparison: subject,
              migration: {
                impact: classSignals > 0 && registrySignals > 0
                  ? "classes-and-registry"
                  : classSignals > 0
                    ? "classes"
                    : registrySignals > 0
                      ? "registry"
                      : "minimal",
                nextActions
              }
            }
          }),
          warnings: compare.warnings
        };
      }
      default:
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Unsupported compare-minecraft task "${task}".`
        });
    }
  }
}
