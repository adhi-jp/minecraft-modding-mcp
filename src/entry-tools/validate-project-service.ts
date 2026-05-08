import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fastGlob from "fast-glob";
import { z } from "zod";

import { mapWithConcurrencyLimit } from "../concurrency.js";
import type { SourceMapping } from "../types.js";
import { buildIncludeSchema, detailSchema } from "./entry-tool-schema.js";
import { buildEntryToolResult, createSummarySubject } from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";
import { handleMixin } from "./validate-project/cases/mixin.js";
import { handleAccessWidener } from "./validate-project/cases/access-widener.js";
import { handleAccessTransformer } from "./validate-project/cases/access-transformer.js";
import { handleProjectSummary } from "./validate-project/cases/project-summary.js";
import {
  buildEarlyTasksForBlocked,
  buildFullTaskStatusReport,
  type ValidateProjectDeps
} from "./validate-project/internal.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;
const WORKSPACE_TEXT_FILE_READ_CONCURRENCY = 4;

export type TaskStatus = "ok" | "skipped" | "missing" | "error";

type TaskEntryBase = {
  status: TaskStatus;
  durationMs?: number;
  error?: { code: string; detail: string };
  warnings?: string[];
};

export type TaskStatusReport = {
  "workspace.detected": TaskEntryBase & { evidence?: string[] };
  "gradle.readable": TaskEntryBase & { propertiesPath?: string; buildScripts?: string[] };
  "loom.cache.found": TaskEntryBase & { cachePath?: string };
  "minecraft.artifact.resolved": TaskEntryBase & { artifactId?: string; mapping?: SourceMapping };
  "mixins.validated": TaskEntryBase & { counts?: { ok: number; partial: number; invalid: number } };
  "accessWideners.validated": TaskEntryBase & { counts?: { ok: number; invalid: number } };
  "accessTransformers.validated": TaskEntryBase & { counts?: { ok: number; invalid: number } };
};

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
      case "mixin":
        return handleMixin(this.deps, input, detail, include);
      case "access-widener":
        return handleAccessWidener(this.deps, input, detail, include);
      case "access-transformer":
        return handleAccessTransformer(this.deps, input, detail, include);
      case "project-summary":
        return handleProjectSummary(this.deps, input, detail, include);
    }
  }
}
