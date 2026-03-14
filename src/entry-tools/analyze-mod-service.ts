import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizePathForHost } from "../path-converter.js";
import type { AnalyzeModOptions, ModAnalysisResult } from "../mod-analyzer.js";
import { createError, ERROR_CODES } from "../errors.js";
import { z } from "zod";
import { buildIncludeSchema, detailSchema, executionModeSchema, positiveIntSchema } from "./entry-tool-schema.js";
import {
  buildEntryToolResult,
  createNextAction,
  createSummarySubject,
  type Summary
} from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "files", "source", "samples", "timings"] as const;

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("jar"),
    jarPath: nonEmptyString
  }),
  z.object({
    kind: z.literal("class"),
    jarPath: nonEmptyString,
    className: nonEmptyString
  })
]);

export const analyzeModShape = {
  task: z.enum(["summary", "decompile", "search", "class-source", "remap"]),
  subject: subjectSchema,
  query: nonEmptyString.optional(),
  searchType: z.enum(["class", "method", "field", "content", "all"]).default("all"),
  limit: positiveIntSchema.default(50),
  includeFiles: z.boolean().default(true),
  maxFiles: positiveIntSchema.optional(),
  maxLines: positiveIntSchema.optional(),
  maxChars: positiveIntSchema.optional(),
  targetMapping: z.enum(["yarn", "mojang"]).optional(),
  outputJar: nonEmptyString.optional(),
  executionMode: executionModeSchema.default("preview"),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS)
};

export const analyzeModSchema = z.object(analyzeModShape).superRefine((value, ctx) => {
  if ((value.task === "summary" || value.task === "decompile" || value.task === "search" || value.task === "remap") && value.subject.kind !== "jar") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: `${value.task} requires subject.kind=jar.`
    });
  }
  if (value.task === "class-source" && value.subject.kind !== "class") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "class-source requires subject.kind=class."
    });
  }
  if (value.task === "search" && !value.query) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["query"],
      message: "search requires query."
    });
  }
  if (value.task === "remap" && !value.targetMapping) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetMapping"],
      message: "remap requires targetMapping."
    });
  }
});

export type AnalyzeModInput = z.infer<typeof analyzeModSchema>;

type AnalyzeModDeps = {
  analyzeModJar: (jarPath: string, options?: AnalyzeModOptions) => Promise<ModAnalysisResult>;
  decompileModJar: (input: {
    jarPath: string;
    includeFiles?: boolean;
    maxFiles?: number;
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  getModClassSource: (input: {
    jarPath: string;
    className: string;
    maxLines?: number;
    maxChars?: number;
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  searchModSource: (input: {
    jarPath: string;
    query: string;
    searchType?: "class" | "method" | "field" | "content" | "all";
    limit?: number;
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  remapModJar: (input: {
    inputJar: string;
    outputJar?: string;
    mcVersion?: string;
    targetMapping: "yarn" | "mojang";
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
};

function deriveOutputJar(inputJar: string, analysis: ModAnalysisResult, targetMapping: "yarn" | "mojang") {
  return join(
    dirname(inputJar),
    `${analysis.modId ?? "mod"}-${analysis.modVersion ?? "0"}-${targetMapping}.jar`
  );
}

export class AnalyzeModService {
  constructor(private readonly deps: AnalyzeModDeps) {}

  async execute(input: AnalyzeModInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);

    switch (input.task) {
      case "summary": {
        const analysis = await this.deps.analyzeModJar(input.subject.jarPath, {
          includeClasses: detail !== "summary" || include.includes("files")
        });
        return {
          ...buildEntryToolResult({
            task: "summary",
            detail,
            include,
            summary: {
              status: "ok",
              headline: `Summarized ${analysis.loader} mod metadata.`,
              subject: createSummarySubject({
                task: "summary",
                kind: input.subject.kind,
                jarPath: input.subject.jarPath
              }),
              counts: {
                classes: analysis.classCount,
                dependencies: analysis.dependencies?.length ?? 0
              }
            },
            blocks: {
              metadata: analysis
            }
          }),
          warnings: []
        };
      }
      case "decompile": {
        const includeFiles = input.includeFiles ?? true;
        const output = await this.deps.decompileModJar({
          jarPath: input.subject.jarPath,
          includeFiles,
          maxFiles: input.maxFiles
        });
        return {
          ...buildEntryToolResult({
            task: "decompile",
            detail,
            include,
            summary: {
              status: "ok",
              headline: `Decompiled ${input.subject.jarPath}.`,
              subject: createSummarySubject({
                task: "decompile",
                kind: input.subject.kind,
                jarPath: input.subject.jarPath,
                includeFiles: includeFiles === true ? undefined : includeFiles,
                maxFiles: input.maxFiles
              })
            },
            blocks: {
              decompile: output
            }
          }),
          warnings: Array.isArray(output.warnings) ? output.warnings : []
        };
      }
      case "search": {
        const searchType = input.searchType ?? "all";
        const limit = input.limit ?? 50;
        const output = await this.deps.searchModSource({
          jarPath: input.subject.jarPath,
          query: input.query!,
          searchType,
          limit
        });
        return {
          ...buildEntryToolResult({
            task: "search",
            detail,
            include,
            summary: {
              status: "ok",
              headline: `Searched ${input.subject.jarPath} for ${input.query}.`,
              subject: createSummarySubject({
                task: "search",
                kind: input.subject.kind,
                jarPath: input.subject.jarPath,
                query: input.query,
                searchType: searchType === "all" ? undefined : searchType,
                limit: limit === 50 ? undefined : limit
              })
            },
            blocks: {
              hits: output
            }
          }),
          warnings: Array.isArray(output.warnings) ? output.warnings : []
        };
      }
      case "class-source": {
        if (input.subject.kind !== "class") {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "class-source requires subject.kind=class."
          });
        }
        const output = await this.deps.getModClassSource({
          jarPath: input.subject.jarPath,
          className: input.subject.className,
          maxLines: input.maxLines,
          maxChars: input.maxChars
        });
        return {
          ...buildEntryToolResult({
            task: "class-source",
            detail,
            include,
            summary: {
              status: "ok",
              headline: `Loaded class source for ${input.subject.className}.`,
              subject: createSummarySubject({
                task: "class-source",
                kind: input.subject.kind,
                jarPath: input.subject.jarPath,
                className: input.subject.className,
                maxLines: input.maxLines,
                maxChars: input.maxChars
              })
            },
            blocks: {
              source: output
            }
          }),
          warnings: Array.isArray(output.warnings) ? output.warnings : []
        };
      }
      case "remap": {
        const normalizedInputJar = normalizePathForHost(input.subject.jarPath, undefined, "jarPath");
        const analysis = await this.deps.analyzeModJar(normalizedInputJar);
        const outputJar = input.outputJar
          ? normalizePathForHost(input.outputJar, undefined, "outputJar")
          : deriveOutputJar(normalizedInputJar, analysis, input.targetMapping!);
        if (outputJar === normalizedInputJar) {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "outputJar must differ from the input jar."
          });
        }
        if ((input.executionMode ?? "preview") === "apply" && existsSync(outputJar)) {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "outputJar already exists. Choose a new destination."
          });
        }
        if ((input.executionMode ?? "preview") === "preview") {
          return {
            ...buildEntryToolResult({
              task: "remap",
              detail,
              include,
              summary: {
                status: "unchanged",
                headline: `Previewed remap output for ${normalizedInputJar}.`,
                subject: createSummarySubject({
                  task: "remap",
                  kind: input.subject.kind,
                  jarPath: normalizedInputJar,
                  executionMode: "preview",
                  targetMapping: input.targetMapping
                }),
                nextActions: [
                  createNextAction("analyze-mod", {
                    task: "remap",
                    subject: {
                      kind: input.subject.kind,
                      jarPath: input.subject.jarPath
                    },
                    executionMode: "apply",
                    targetMapping: input.targetMapping
                  })
                ]
              },
              blocks: {
                metadata: {
                  loader: analysis.loader,
                  modId: analysis.modId,
                  modVersion: analysis.modVersion
                },
                operation: {
                  executionMode: "preview",
                  outputJar,
                  targetMapping: input.targetMapping
                }
              },
              alwaysBlocks: ["operation"]
            }),
            warnings: []
          };
        }
        const output = await this.deps.remapModJar({
          inputJar: normalizedInputJar,
          outputJar,
          targetMapping: input.targetMapping!
        });
        return {
          ...buildEntryToolResult({
            task: "remap",
            detail,
            include,
            summary: {
              status: "changed",
              headline: `Remapped ${normalizedInputJar} to ${input.targetMapping}.`,
              subject: createSummarySubject({
                task: "remap",
                kind: input.subject.kind,
                jarPath: normalizedInputJar,
                executionMode: "apply",
                targetMapping: input.targetMapping
              })
            },
            blocks: {
              operation: {
                executionMode: "apply",
                outputJar,
                targetMapping: input.targetMapping
              },
              metadata: output
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: Array.isArray(output.warnings) ? output.warnings : []
        };
      }
    }
  }
}
