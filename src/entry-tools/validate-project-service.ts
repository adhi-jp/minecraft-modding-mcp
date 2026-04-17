import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fastGlob from "fast-glob";
import { z } from "zod";

import { mapWithConcurrencyLimit } from "../concurrency.js";
import { createError, ERROR_CODES } from "../errors.js";
import { buildIncludeSchema, detailSchema } from "./entry-tool-schema.js";
import { buildEntryToolResult, createSummarySubject } from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;
const WORKSPACE_TEXT_FILE_READ_CONCURRENCY = 4;

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

const accessTransformerInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), content: nonEmptyString }),
  z.object({ mode: z.literal("path"), path: nonEmptyString })
]);

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    projectPath: nonEmptyString,
    discover: z.array(z.enum(["mixins", "access-wideners", "access-transformers"])).optional()
  }),
  z.object({
    kind: z.literal("mixin"),
    input: mixinInputSchema
  }),
  z.object({
    kind: z.literal("access-widener"),
    input: accessWidenerInputSchema
  }),
  z.object({
    kind: z.literal("access-transformer"),
    input: accessTransformerInputSchema
  })
]);

export const validateProjectShape = {
  task: z.enum(["project-summary", "mixin", "access-widener", "access-transformer"]),
  subject: subjectSchema,
  version: nonEmptyString.optional(),
  mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
  atNamespace: z.enum(["srg", "mojang", "obfuscated"]).optional(),
  sourcePriority: z.enum(["loom-first", "maven-first"]).optional(),
  scope: z.enum(["vanilla", "merged", "loader"]).optional(),
  preferProjectVersion: z.boolean().optional(),
  preferProjectMapping: z.boolean().default(false),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS),
  sourceRoots: z.array(nonEmptyString).optional(),
  configPaths: z.array(nonEmptyString).optional(),
  minSeverity: z.enum(["error", "warning", "all"]).default("all"),
  hideUncertain: z.boolean().default(false),
  explain: z.boolean().default(false),
  warningMode: z.enum(["full", "aggregated"]).optional(),
  warningCategoryFilter: z.array(z.enum(["mapping", "configuration", "validation", "resolution", "parse"])).optional(),
  treatInfoAsWarning: z.boolean().default(true),
  includeIssues: z.boolean().default(true)
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
  if (value.task === "access-transformer" && value.subject.kind !== "access-transformer") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "kind"],
      message: "task=access-transformer requires subject.kind=access-transformer."
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
    projectPath?: string;
    scope?: "vanilla" | "merged" | "loader";
    preferProjectVersion?: boolean;
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  validateAccessTransformer?: (input: {
    content: string;
    version: string;
    atNamespace?: "srg" | "mojang" | "obfuscated";
    sourcePriority?: "loom-first" | "maven-first";
    projectPath?: string;
    scope?: "vanilla" | "merged" | "loader";
    preferProjectVersion?: boolean;
  }) => Promise<Record<string, unknown> & { warnings?: string[] }>;
  discoverMixins: (projectPath: string, configPaths?: string[]) => Promise<string[]>;
  discoverAccessWideners: (projectPath: string) => Promise<string[]>;
  discoverAccessTransformers?: (projectPath: string) => Promise<string[]>;
  detectProjectMinecraftVersion?: (projectPath: string) => Promise<string | undefined>;
};

export async function discoverWorkspaceMixins(projectPath: string, configPaths?: string[]): Promise<string[]> {
  if (configPaths?.length) {
    return [...configPaths];
  }
  return (await fastGlob.glob(["**/*.mixins.json"], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  })).sort((left, right) => left.localeCompare(right));
}

export async function discoverWorkspaceAccessWideners(projectPath: string): Promise<string[]> {
  const descriptorFiles = (await fastGlob.glob(["fabric.mod.json", "quilt.mod.json", "**/fabric.mod.json", "**/quilt.mod.json"], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  })).sort((left, right) => left.localeCompare(right));
  const discovered = new Set<string>();
  const matches = await mapWithConcurrencyLimit(
    descriptorFiles,
    WORKSPACE_TEXT_FILE_READ_CONCURRENCY,
    async (descriptorPath): Promise<string[]> => {
      try {
        const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
          accessWidener?: string;
          access_widener?: string;
        };
        const relative = parsed.accessWidener ?? parsed.access_widener;
        return relative ? [resolve(descriptorPath, "..", relative)] : [];
      } catch {
        return [];
      }
    }
  );
  for (const matchList of matches) {
    for (const match of matchList) {
      discovered.add(match);
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function addDiscoveredPath(discovered: Set<string>, filePath: string, relativePath: string | undefined): void {
  const trimmed = relativePath?.trim();
  if (!trimmed) {
    return;
  }
  discovered.add(resolve(filePath, "..", trimmed));
}

function collectFileArgumentMatches(
  content: string,
  filePath: string,
  discovered: Set<string>,
  pattern: RegExp
): void {
  for (const match of content.matchAll(pattern)) {
    addDiscoveredPath(discovered, filePath, match[2]);
  }
}

function extractNamedDslBlocks(content: string, blockName: string): string[] {
  const blocks: string[] = [];
  const blockPattern = new RegExp(`${blockName}\\s*\\{`, "g");

  for (const match of content.matchAll(blockPattern)) {
    const blockStart = (match.index ?? -1) + match[0].length;
    if (blockStart < match[0].length) {
      continue;
    }

    let depth = 1;
    for (let index = blockStart; index < content.length; index++) {
      const char = content[index];
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
      }
      if (depth === 0) {
        blocks.push(content.slice(blockStart, index));
        break;
      }
    }
  }

  return blocks;
}

function collectTomlAccessTransformerEntries(content: string, filePath: string, discovered: Set<string>): void {
  const lines = content.split(/\r?\n/);
  let currentBlock: string[] = [];

  const flushBlock = (): void => {
    if (currentBlock.length === 0) {
      return;
    }
    for (const match of currentBlock.join("\n").matchAll(/^\s*file\s*=\s*(["'])(.+?)\1\s*$/gm)) {
      addDiscoveredPath(discovered, filePath, match[2]);
    }
    currentBlock = [];
  };

  for (const line of lines) {
    if (/^\s*\[\[accessTransformers\]\]\s*$/.test(line)) {
      flushBlock();
      currentBlock.push(line);
      continue;
    }
    if (currentBlock.length > 0 && /^\s*(?:\[\[.*\]\]|\[[^\[])/.test(line)) {
      flushBlock();
    }
    if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }

  flushBlock();
}

export async function discoverWorkspaceAccessTransformers(projectPath: string): Promise<string[]> {
  const discovered = new Set<string>();
  const textFiles = (await fastGlob.glob([
    "build.gradle",
    "build.gradle.kts",
    "META-INF/mods.toml",
    "META-INF/neoforge.mods.toml",
    "**/build.gradle",
    "**/build.gradle.kts",
    "**/META-INF/mods.toml",
    "**/META-INF/neoforge.mods.toml"
  ], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  })).sort((left, right) => left.localeCompare(right));

  const discoveredByFile = await mapWithConcurrencyLimit(
    textFiles,
    WORKSPACE_TEXT_FILE_READ_CONCURRENCY,
    async (filePath): Promise<string[]> => {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        return [];
      }

      const perFileDiscovered = new Set<string>();
      collectFileArgumentMatches(
        content,
        filePath,
        perFileDiscovered,
        /accessTransformer\s*=\s*file\(\s*(["'])(.+?)\1\s*\)/g
      );
      collectFileArgumentMatches(
        content,
        filePath,
        perFileDiscovered,
        /accessTransformers\.from\s*\(\s*file\(\s*(["'])(.+?)\1\s*\)\s*\)/g
      );
      for (const block of extractNamedDslBlocks(content, "accessTransformers")) {
        collectFileArgumentMatches(block, filePath, perFileDiscovered, /file\(\s*(["'])(.+?)\1\s*\)/g);
      }
      collectTomlAccessTransformerEntries(content, filePath, perFileDiscovered);
      return [...perFileDiscovered];
    }
  );
  for (const matchList of discoveredByFile) {
    for (const match of matchList) {
      discovered.add(match);
    }
  }

  for (const fallbackPath of (await fastGlob.glob([
    "**/META-INF/accesstransformer.cfg",
    "**/*_at.cfg",
    "**/accesstransformer*.cfg"
  ], {
    cwd: projectPath,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/.git/**", "**/build/**", "**/out/**", "**/node_modules/**"]
  })).sort((left, right) => left.localeCompare(right))) {
    discovered.add(fallbackPath);
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
              suggestedCall: {
                tool: "validate-project",
                params: {
                  task: "mixin",
                  subject: input.subject,
                  version: "1.21.10"
                }
              }
            }
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
      case "access-widener": {
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
              suggestedCall: {
                tool: "validate-project",
                params: {
                  task: "access-widener",
                  subject: input.subject,
                  version: "1.21.10"
                }
              }
            }
          });
        }
        const content = input.subject.input.mode === "inline"
          ? input.subject.input.content
          : await readFile(input.subject.input.path, "utf8");
        const output = await this.deps.validateAccessWidener({
          content,
          version: input.version,
          mapping: input.mapping,
          sourcePriority: input.sourcePriority,
          scope: input.scope,
          preferProjectVersion: input.preferProjectVersion
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
              issues: include.includes("issues") || detail !== "summary" ? output.issues : undefined
            },
            alwaysBlocks: ["project"]
          }),
          warnings: Array.isArray(output.warnings) ? output.warnings : []
        };
      }
      case "access-transformer": {
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
              suggestedCall: {
                tool: "validate-project",
                params: {
                  task: "access-transformer",
                  subject: input.subject,
                  version: "1.21.10"
                }
              }
            }
          });
        }
        const content = input.subject.input.mode === "inline"
          ? input.subject.input.content
          : await readFile(input.subject.input.path, "utf8");
        if (!this.deps.validateAccessTransformer) {
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
        const output = await this.deps.validateAccessTransformer({
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
                subject: createSummarySubject({
                  task: "project-summary",
                  kind: input.subject.kind,
                  projectPath: input.subject.projectPath,
                  discover: input.subject.discover
                }),
                nextActions: [
                  {
                    tool: "validate-project",
                    params: {
                      task: "project-summary",
                      subject: input.subject
                    }
                  }
                ],
                notes: [
                  "Pass version explicitly, or retry with preferProjectVersion=true when gradle.properties declares the Minecraft version."
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
        const detectedProjectVersion = input.preferProjectVersion
          ? await this.deps.detectProjectMinecraftVersion?.(projectPath)
          : undefined;
        const resolvedVersion = detectedProjectVersion ?? input.version;
        const discover = input.subject.discover ?? ["mixins", "access-wideners"];
        const [mixinConfigs, accessWideners, accessTransformers] = await Promise.all([
          discover.includes("mixins")
            ? this.deps.discoverMixins(projectPath, input.configPaths)
            : Promise.resolve([]),
          discover.includes("access-wideners")
            ? this.deps.discoverAccessWideners(projectPath)
            : Promise.resolve([]),
          discover.includes("access-transformers")
            ? this.deps.discoverAccessTransformers?.(projectPath) ?? Promise.resolve([])
            : Promise.resolve([])
        ]);

        if (!resolvedVersion && (mixinConfigs.length > 0 || accessWideners.length > 0 || accessTransformers.length > 0)) {
          return {
            ...buildEntryToolResult({
              task: "project-summary",
              detail,
              include,
              summary: {
                status: "blocked",
                headline: "Could not resolve Minecraft version for discovered workspace validators.",
                subject: createSummarySubject({
                  task: "project-summary",
                  kind: input.subject.kind,
                  projectPath,
                  discover: input.subject.discover,
                  mapping: input.mapping,
                  sourcePriority: input.sourcePriority,
                  scope: input.scope
                }),
                nextActions: [
                  {
                    tool: "validate-project",
                    params: {
                      task: "project-summary",
                      subject: input.subject
                    }
                  }
                ],
                notes: [
                  "Pass version explicitly, or make sure gradle.properties declares the Minecraft version before using preferProjectVersion=true."
                ]
              },
              blocks: {
                workspace: {
                  projectPath
                }
              }
            }),
            warnings: [
              "Could not resolve Minecraft version from gradle.properties for discovered workspace validators."
            ]
          };
        }

        if (!resolvedVersion) {
          return {
            ...buildEntryToolResult({
              task: "project-summary",
              detail,
              include,
              summary: {
                status: "ok",
                headline: `Validated ${mixinConfigs.length} mixin config(s), ${accessWideners.length} access widener(s), and ${accessTransformers.length} access transformer(s).`,
                subject: createSummarySubject({
                  task: "project-summary",
                  kind: input.subject.kind,
                  projectPath,
                  discover: input.subject.discover,
                  mapping: input.mapping,
                  sourcePriority: input.sourcePriority,
                  scope: input.scope
                }),
                counts: {
                  valid: 0,
                  partial: 0,
                  invalid: 0
                }
              },
              blocks: {
                workspace: {
                  projectPath
                }
              }
            }),
            warnings: []
          };
        }

        const validationVersion = resolvedVersion;
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
              version: validationVersion,
              mapping: input.mapping,
              sourcePriority: input.sourcePriority,
              scope: input.scope,
              projectPath,
              preferProjectVersion: false,
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
              version: validationVersion,
              mapping: input.mapping,
              sourcePriority: input.sourcePriority,
              projectPath,
              scope: input.scope,
              preferProjectVersion: input.preferProjectVersion
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

        let validAt = 0;
        let invalidAt = 0;
        for (const atPath of accessTransformers) {
          try {
            if (!this.deps.validateAccessTransformer) {
              throw createError({
                code: ERROR_CODES.CONTEXT_UNRESOLVED,
                message: "Access Transformer validation is not configured."
              });
            }
            const output = await this.deps.validateAccessTransformer({
              content: await readFile(atPath, "utf8"),
              version: validationVersion,
              atNamespace: input.atNamespace,
              sourcePriority: input.sourcePriority,
              projectPath,
              scope: input.scope,
              preferProjectVersion: input.preferProjectVersion
            });
            if (output.valid) {
              validAt += 1;
            } else {
              invalidAt += 1;
            }
            if (Array.isArray(output.warnings)) {
              warnings.push(...output.warnings);
            }
          } catch (error) {
            invalidAt += 1;
            if (error instanceof Error) {
              warnings.push(error.message);
            }
          }
        }

        const invalidCount = invalidMixins + invalidAw + invalidAt;
        const partialCount = partialMixins;
        const status = invalidCount > 0 ? "invalid" : partialCount > 0 ? "partial" : "ok";

        return {
          ...buildEntryToolResult({
            task: "project-summary",
            detail,
            include,
            summary: {
              status,
              headline: `Validated ${mixinConfigs.length} mixin config(s), ${accessWideners.length} access widener(s), and ${accessTransformers.length} access transformer(s).`,
              subject: createSummarySubject({
                task: "project-summary",
                kind: input.subject.kind,
                projectPath,
                discover: input.subject.discover,
                version: resolvedVersion,
                mapping: input.mapping,
                sourcePriority: input.sourcePriority,
                scope: input.scope
              }),
              counts: {
                valid: validMixins + validAw + validAt,
                partial: partialCount,
                invalid: invalidCount
              }
            },
            blocks: {
              project: {
                summary: {
                  valid: validMixins + validAw + validAt,
                  partial: partialCount,
                  invalid: invalidCount
                }
              },
              workspace: {
                projectPath,
                mixinConfigs,
                accessWideners,
                accessTransformers
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
