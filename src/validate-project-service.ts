import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fastGlob from "fast-glob";
import { z } from "zod";

import { createError, ERROR_CODES } from "./errors.js";
import { buildIncludeSchema, detailSchema } from "./v3/entry-tool-schema.js";
import { buildEntryToolResult } from "./v3/response-contract.js";
import { resolveDetail, resolveInclude } from "./v3/request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;

const mixinInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), source: nonEmptyString }),
  z.object({ mode: z.literal("path"), path: nonEmptyString }),
  z.object({ mode: z.literal("paths"), paths: z.array(nonEmptyString).min(1) }),
  z.object({ mode: z.literal("config"), configPaths: z.array(nonEmptyString).min(1) }),
  z.object({ mode: z.literal("project"), path: nonEmptyString })
]);

const accessWidenerInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), content: nonEmptyString }),
  z.object({ mode: z.literal("path"), path: nonEmptyString })
]);

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    projectPath: nonEmptyString,
    discover: z.array(z.enum(["mixins", "access-wideners"])).optional()
  }),
  z.object({
    kind: z.literal("mixin"),
    input: mixinInputSchema
  }),
  z.object({
    kind: z.literal("access-widener"),
    input: accessWidenerInputSchema
  })
]);

export const validateProjectShape = {
  task: z.enum(["project-summary", "mixin", "access-widener"]),
  subject: subjectSchema,
  version: nonEmptyString.optional(),
  mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  sourcePriority: z.enum(["loom-first", "maven-first"]).optional(),
  scope: z.enum(["vanilla", "merged", "loader"]).optional(),
  preferProjectVersion: z.boolean().optional(),
  preferProjectMapping: z.boolean().optional(),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS),
  sourceRoots: z.array(nonEmptyString).optional(),
  configPaths: z.array(nonEmptyString).optional(),
  minSeverity: z.enum(["error", "warning", "all"]).optional(),
  hideUncertain: z.boolean().optional(),
  explain: z.boolean().optional(),
  warningMode: z.enum(["full", "aggregated"]).optional(),
  warningCategoryFilter: z.array(z.enum(["mapping", "configuration", "validation", "resolution", "parse"])).optional(),
  treatInfoAsWarning: z.boolean().optional(),
  includeIssues: z.boolean().optional()
};

export const validateProjectSchema = z.object(validateProjectShape).superRefine((value, ctx) => {
  if (value.task === "project-summary" && value.subject.kind !== "workspace") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=project-summary requires subject.kind=workspace."
    });
  }
  if (value.task === "mixin" && value.subject.kind !== "mixin") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=mixin requires subject.kind=mixin."
    });
  }
  if (value.task === "access-widener" && value.subject.kind !== "access-widener") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=access-widener requires subject.kind=access-widener."
    });
  }
  if (value.configPaths?.length && value.task !== "project-summary") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["configPaths"],
      message: "configPaths is only supported for task=project-summary workspace discovery."
    });
  }
});

export type ValidateProjectInput = z.infer<typeof validateProjectSchema>;

type ValidateProjectDeps = {
  validateMixin: (input: Record<string, unknown>) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  validateAccessWidener: (input: {
    content: string;
    version: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  discoverMixins: (projectPath: string, configPaths?: string[]) => Promise<string[]>;
  discoverAccessWideners: (projectPath: string) => Promise<string[]>;
};

export async function discoverWorkspaceMixins(projectPath: string, configPaths?: string[]): Promise<string[]> {
  if (configPaths?.length) {
    return [...configPaths];
  }
  return fastGlob.sync(["**/*.mixins.json"], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  });
}

export async function discoverWorkspaceAccessWideners(projectPath: string): Promise<string[]> {
  const descriptorFiles = fastGlob.sync(["fabric.mod.json", "quilt.mod.json", "**/fabric.mod.json", "**/quilt.mod.json"], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  });
  const discovered = new Set<string>();
  for (const descriptorPath of descriptorFiles) {
    try {
      const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
        accessWidener?: string;
        access_widener?: string;
      };
      const relative = parsed.accessWidener ?? parsed.access_widener;
      if (relative) {
        discovered.add(resolve(descriptorPath, "..", relative));
      }
    } catch {
      // ignore malformed descriptors in discovery mode
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

export class ValidateProjectService {
  constructor(private readonly deps: ValidateProjectDeps) {}

  async execute(input: ValidateProjectInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);

    switch (input.task) {
      case "mixin": {
        if (input.subject.kind !== "mixin") {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "task=mixin requires subject.kind=mixin."
          });
        }
        const output = await this.deps.validateMixin({
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
          includeIssues: input.includeIssues
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
      case "access-widener": {
        if (input.subject.kind !== "access-widener") {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "task=access-widener requires subject.kind=access-widener."
          });
        }
        const content = input.subject.input.mode === "inline"
          ? input.subject.input.content
          : await readFile(input.subject.input.path, "utf8");
        const output = await this.deps.validateAccessWidener({
          content,
          version: input.version!,
          mapping: input.mapping,
          sourcePriority: input.sourcePriority
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
      case "project-summary": {
        if (input.subject.kind !== "workspace") {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: "task=project-summary requires subject.kind=workspace."
          });
        }
        if (!input.version && !input.preferProjectVersion) {
          return {
            ...buildEntryToolResult({
              task: "project-summary",
              detail,
              include,
              summary: {
                status: "blocked",
                headline: "project-summary requires version or preferProjectVersion=true.",
                nextActions: [
                  {
                    tool: "validate-project",
                    params: {
                      task: "project-summary",
                      version: "1.21.10",
                      subject: input.subject
                    }
                  }
                ]
              },
              blocks: {
                workspace: {
                  projectPath: input.subject.projectPath
                }
              }
            }),
            warnings: []
          };
        }

        const projectPath = input.subject.projectPath;
        const discover = input.subject.discover ?? ["mixins", "access-wideners"];
        const [mixinConfigs, accessWideners] = await Promise.all([
          discover.includes("mixins")
            ? this.deps.discoverMixins(projectPath, input.configPaths)
            : Promise.resolve([]),
          discover.includes("access-wideners")
            ? this.deps.discoverAccessWideners(projectPath)
            : Promise.resolve([])
        ]);

        const warnings: string[] = [];
        let validMixins = 0;
        let partialMixins = 0;
        let invalidMixins = 0;
        for (const configPath of mixinConfigs) {
          try {
            const mixinResult = await this.deps.validateMixin({
              input: {
                mode: "config",
                configPaths: [configPath]
              },
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
              includeIssues: input.includeIssues
            });
            const summary = mixinResult.summary as {
              valid?: number;
              partial?: number;
              invalid?: number;
            } | undefined;
            validMixins += summary?.valid ?? 0;
            partialMixins += summary?.partial ?? 0;
            invalidMixins += summary?.invalid ?? 0;
            if (Array.isArray(mixinResult.warnings)) {
              warnings.push(...mixinResult.warnings);
            }
          } catch (error) {
            invalidMixins += 1;
            if (error instanceof Error) {
              warnings.push(`${configPath}: ${error.message}`);
            }
          }
        }

        let validAw = 0;
        let invalidAw = 0;
        for (const awPath of accessWideners) {
          try {
            const output = await this.deps.validateAccessWidener({
              content: await readFile(awPath, "utf8"),
              version: input.version!,
              mapping: input.mapping,
              sourcePriority: input.sourcePriority
            });
            if (output.valid) {
              validAw += 1;
            } else {
              invalidAw += 1;
            }
            if (Array.isArray(output.warnings)) {
              warnings.push(...output.warnings);
            }
          } catch (error) {
            invalidAw += 1;
            if (error instanceof Error) {
              warnings.push(error.message);
            }
          }
        }

        const invalidCount = invalidMixins + invalidAw;
        const partialCount = partialMixins;
        const status = invalidCount > 0 ? "invalid" : partialCount > 0 ? "partial" : "ok";

        return {
          ...buildEntryToolResult({
            task: "project-summary",
            detail,
            include,
            summary: {
              status,
              headline: `Validated ${mixinConfigs.length} mixin config(s) and ${accessWideners.length} access widener(s).`,
              counts: {
                valid: validMixins + validAw,
                partial: partialCount,
                invalid: invalidCount
              }
            },
            blocks: {
              project: {
                summary: {
                  valid: validMixins + validAw,
                  partial: partialCount,
                  invalid: invalidCount
                }
              },
              workspace: {
                projectPath,
                mixinConfigs,
                accessWideners
              }
            },
            alwaysBlocks: ["project"]
          }),
          warnings
        };
      }
    }
  }
}
