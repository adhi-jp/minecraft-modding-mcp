import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fastGlob from "fast-glob";
import { z } from "zod";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { mapWithConcurrencyLimit } from "../concurrency.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { buildVersionSourceSearchRoots } from "../gradle-paths.js";
import type { SourceMapping } from "../types.js";
import { buildIncludeSchema, detailSchema } from "./entry-tool-schema.js";
import { buildEntryToolResult, createSummarySubject } from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "issues", "workspace", "recovery"] as const;
const WORKSPACE_TEXT_FILE_READ_CONCURRENCY = 4;

const VALIDATE_PROJECT_TASKS_OFF = process.env.VALIDATE_PROJECT_TASKS_OFF === "1";

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

const TASK_KEYS = [
  "workspace.detected",
  "gradle.readable",
  "loom.cache.found",
  "minecraft.artifact.resolved",
  "mixins.validated",
  "accessWideners.validated",
  "accessTransformers.validated"
] as const;

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
  resolveArtifact?: (input: {
    target: { kind: "version"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    projectPath?: string;
    scope?: "vanilla" | "merged" | "loader";
    preferProjectVersion?: boolean;
  }) => Promise<{
    artifactId: string;
    mappingApplied: SourceMapping;
    warnings?: string[];
  }>;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function probeWorkspaceDetected(projectPath: string): Promise<TaskStatusReport["workspace.detected"]> {
  const startedAt = Date.now();
  const candidates = [
    "gradle.properties",
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts"
  ];
  try {
    const evidence: string[] = [];
    for (const candidate of candidates) {
      if (await pathExists(resolve(projectPath, candidate))) {
        evidence.push(candidate);
      }
    }
    const durationMs = Date.now() - startedAt;
    if (evidence.length === 0) {
      return { status: "missing", durationMs };
    }
    return { status: "ok", durationMs, evidence };
  } catch (error) {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      error: {
        code: isAppError(error) ? error.code : "ERR_PROBE_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function probeGradleReadable(projectPath: string): Promise<TaskStatusReport["gradle.readable"]> {
  const startedAt = Date.now();
  const propertiesPath = resolve(projectPath, "gradle.properties");
  try {
    const propsExists = await pathExists(propertiesPath);
    let propsRead = false;
    if (propsExists) {
      await readFile(propertiesPath, "utf8");
      propsRead = true;
    }
    const buildScriptCandidates = [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts"
    ];
    const buildScripts: string[] = [];
    for (const candidate of buildScriptCandidates) {
      if (await pathExists(resolve(projectPath, candidate))) {
        buildScripts.push(candidate);
      }
    }
    const durationMs = Date.now() - startedAt;
    if (!propsExists && buildScripts.length === 0) {
      return { status: "missing", durationMs };
    }
    return {
      status: "ok",
      durationMs,
      ...(propsRead ? { propertiesPath } : {}),
      buildScripts
    };
  } catch (error) {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      error: {
        code: isAppError(error) ? error.code : "ERR_GRADLE_READ_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function probeLoomCacheFound(projectPath: string): Promise<TaskStatusReport["loom.cache.found"]> {
  const startedAt = Date.now();
  try {
    const roots = buildVersionSourceSearchRoots(projectPath);
    for (const root of roots) {
      if (await pathExists(root)) {
        return {
          status: "ok",
          durationMs: Date.now() - startedAt,
          cachePath: root
        };
      }
    }
    return { status: "missing", durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      error: {
        code: isAppError(error) ? error.code : "ERR_LOOM_PROBE_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function probeMinecraftArtifactResolved(
  resolveArtifact: NonNullable<ValidateProjectDeps["resolveArtifact"]>,
  args: {
    version: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    projectPath: string;
    scope?: "vanilla" | "merged" | "loader";
    preferProjectVersion?: boolean;
  }
): Promise<TaskStatusReport["minecraft.artifact.resolved"]> {
  const startedAt = Date.now();
  try {
    const output = await resolveArtifact({
      target: { kind: "version", value: args.version },
      mapping: args.mapping,
      sourcePriority: args.sourcePriority,
      projectPath: args.projectPath,
      scope: args.scope,
      preferProjectVersion: args.preferProjectVersion
    });
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      artifactId: output.artifactId,
      mapping: output.mappingApplied,
      ...(Array.isArray(output.warnings) && output.warnings.length > 0
        ? { warnings: output.warnings }
        : {})
    };
  } catch (error) {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      error: {
        code: isAppError(error) ? error.code : "ERR_ARTIFACT_PROBE_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function downstreamSkipReason(
  report: Pick<TaskStatusReport, "workspace.detected" | "gradle.readable" | "minecraft.artifact.resolved">,
  upstream: ReadonlyArray<keyof typeof report>
): TaskEntryBase | undefined {
  for (const key of upstream) {
    const entry = report[key];
    if (entry.status !== "ok") {
      return { status: "skipped" };
    }
  }
  return undefined;
}

function buildValidationEntryWithCounts<T extends { ok: number; invalid: number }>(
  upstream: TaskEntryBase | undefined,
  discoveredCount: number,
  errorCount: number,
  counts: T,
  durationMs: number
): TaskEntryBase & { counts?: T } {
  if (upstream) {
    return upstream;
  }
  if (discoveredCount === 0) {
    return { status: "missing", durationMs };
  }
  if (errorCount > 0) {
    return { status: "error", durationMs, counts };
  }
  return { status: "ok", durationMs, counts };
}

function projectTaskEntry<T extends TaskEntryBase>(
  entry: T,
  detail: "summary" | "standard" | "full",
  include: string[]
): TaskEntryBase {
  const fullDetail = detail !== "summary" && include.includes("workspace");
  if (fullDetail) {
    return entry;
  }
  const slim: TaskEntryBase = { status: entry.status };
  if (entry.error) {
    slim.error = entry.error;
  }
  if (entry.warnings && entry.warnings.length > 0) {
    slim.warnings = entry.warnings;
  }
  return slim;
}

function projectTaskStatusReport(
  report: TaskStatusReport,
  detail: "summary" | "standard" | "full",
  include: string[]
): TaskStatusReport {
  const projected: Record<string, TaskEntryBase> = {};
  for (const key of TASK_KEYS) {
    projected[key] = projectTaskEntry(report[key], detail, include);
  }
  return projected as TaskStatusReport;
}

export class ValidateProjectService {
  constructor(private readonly deps: ValidateProjectDeps) {}

  private async runUpstreamProbes(projectPath: string): Promise<{
    workspace: TaskStatusReport["workspace.detected"];
    gradle: TaskStatusReport["gradle.readable"];
    loom: TaskStatusReport["loom.cache.found"];
  }> {
    const workspace = await probeWorkspaceDetected(projectPath);
    const loom = await probeLoomCacheFound(projectPath);
    let gradle: TaskStatusReport["gradle.readable"];
    if (workspace.status !== "ok") {
      gradle = { status: "skipped" };
    } else {
      gradle = await probeGradleReadable(projectPath);
    }
    return { workspace, gradle, loom };
  }

  private async buildEarlyTasksForBlocked(
    projectPath: string,
    detail: "summary" | "standard" | "full",
    include: string[],
    discovery?: {
      mixinDiscoveryCount: number;
      awDiscoveryCount: number;
      atDiscoveryCount: number;
    }
  ): Promise<TaskStatusReport | undefined> {
    if (VALIDATE_PROJECT_TASKS_OFF) {
      return undefined;
    }
    const { workspace, gradle, loom } = await this.runUpstreamProbes(projectPath);
    const minecraftArtifactResolved: TaskStatusReport["minecraft.artifact.resolved"] = {
      status: "skipped"
    };
    const validatedSkipped: TaskEntryBase = { status: "skipped" };
    const buildValidatorEntry = (
      discoveredCount: number | undefined
    ): TaskEntryBase => {
      if (workspace.status !== "ok" || gradle.status !== "ok") {
        return validatedSkipped;
      }
      if (minecraftArtifactResolved.status !== "ok") {
        return validatedSkipped;
      }
      return discoveredCount === 0 || discoveredCount === undefined
        ? { status: "missing" }
        : validatedSkipped;
    };
    const report: TaskStatusReport = {
      "workspace.detected": workspace,
      "gradle.readable": gradle,
      "loom.cache.found": loom,
      "minecraft.artifact.resolved": minecraftArtifactResolved,
      "mixins.validated": buildValidatorEntry(discovery?.mixinDiscoveryCount),
      "accessWideners.validated": buildValidatorEntry(discovery?.awDiscoveryCount),
      "accessTransformers.validated": buildValidatorEntry(discovery?.atDiscoveryCount)
    };
    return projectTaskStatusReport(report, detail, include);
  }

  private async buildFullTaskStatusReport(args: {
    projectPath: string;
    detail: "summary" | "standard" | "full";
    include: string[];
    resolvedVersion: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    scope?: "vanilla" | "merged" | "loader";
    preferProjectVersion?: boolean;
    mixinDiscoveryCount: number;
    mixinCaughtErrors: number;
    mixinCounts: { ok: number; partial: number; invalid: number };
    mixinDurationMs: number;
    awDiscoveryCount: number;
    awCaughtErrors: number;
    awCounts: { ok: number; invalid: number };
    awDurationMs: number;
    atDiscoveryCount: number;
    atCaughtErrors: number;
    atCounts: { ok: number; invalid: number };
    atDurationMs: number;
  }): Promise<TaskStatusReport | undefined> {
    if (VALIDATE_PROJECT_TASKS_OFF) {
      return undefined;
    }
    const { workspace, gradle, loom } = await this.runUpstreamProbes(args.projectPath);
    let minecraftArtifactResolved: TaskStatusReport["minecraft.artifact.resolved"];
    if (workspace.status !== "ok" || gradle.status !== "ok") {
      minecraftArtifactResolved = { status: "skipped" };
    } else if (this.deps.resolveArtifact) {
      minecraftArtifactResolved = await probeMinecraftArtifactResolved(this.deps.resolveArtifact, {
        version: args.resolvedVersion,
        mapping: args.mapping,
        sourcePriority: args.sourcePriority,
        projectPath: args.projectPath,
        scope: args.scope,
        preferProjectVersion: args.preferProjectVersion
      });
    } else {
      minecraftArtifactResolved = { status: "skipped" };
    }
    const upstreamSkip = downstreamSkipReason(
      {
        "workspace.detected": workspace,
        "gradle.readable": gradle,
        "minecraft.artifact.resolved": minecraftArtifactResolved
      },
      ["workspace.detected", "gradle.readable", "minecraft.artifact.resolved"]
    );
    const mixinsValidated = buildValidationEntryWithCounts<{ ok: number; partial: number; invalid: number }>(
      upstreamSkip,
      args.mixinDiscoveryCount,
      args.mixinCaughtErrors,
      args.mixinCounts,
      args.mixinDurationMs
    );
    const accessWidenersValidated = buildValidationEntryWithCounts<{ ok: number; invalid: number }>(
      upstreamSkip,
      args.awDiscoveryCount,
      args.awCaughtErrors,
      args.awCounts,
      args.awDurationMs
    );
    const accessTransformersValidated = buildValidationEntryWithCounts<{ ok: number; invalid: number }>(
      upstreamSkip,
      args.atDiscoveryCount,
      args.atCaughtErrors,
      args.atCounts,
      args.atDurationMs
    );
    const report: TaskStatusReport = {
      "workspace.detected": workspace,
      "gradle.readable": gradle,
      "loom.cache.found": loom,
      "minecraft.artifact.resolved": minecraftArtifactResolved,
      "mixins.validated": mixinsValidated,
      "accessWideners.validated": accessWidenersValidated,
      "accessTransformers.validated": accessTransformersValidated
    };
    return projectTaskStatusReport(report, args.detail, args.include);
  }

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
              ...buildSuggestedCall({
                tool: "validate-project",
                params: {
                  task: "access-widener",
                  subject: input.subject,
                  version: "1.21.10"
                }
              })
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
              ...buildSuggestedCall({
                tool: "validate-project",
                params: {
                  task: "access-transformer",
                  subject: input.subject,
                  version: "1.21.10"
                }
              })
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
          const baseResult = buildEntryToolResult({
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
          });
          const tasks = await this.buildEarlyTasksForBlocked(input.subject.projectPath, detail, include);
          return {
            ...baseResult,
            ...(tasks ? { tasks } : {}),
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
          const baseResult = buildEntryToolResult({
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
          });
          const tasks = await this.buildEarlyTasksForBlocked(projectPath, detail, include, {
            mixinDiscoveryCount: mixinConfigs.length,
            awDiscoveryCount: accessWideners.length,
            atDiscoveryCount: accessTransformers.length
          });
          return {
            ...baseResult,
            ...(tasks ? { tasks } : {}),
            warnings: [
              "Could not resolve Minecraft version from gradle.properties for discovered workspace validators."
            ]
          };
        }

        if (!resolvedVersion) {
          const baseResult = buildEntryToolResult({
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
          });
          const tasks = await this.buildEarlyTasksForBlocked(projectPath, detail, include);
          return {
            ...baseResult,
            ...(tasks ? { tasks } : {}),
            warnings: []
          };
        }

        const validationVersion = resolvedVersion;
        const warnings: string[] = [];
        const mixinDurationStart = Date.now();
        let validMixins = 0;
        let partialMixins = 0;
        let invalidMixins = 0;
        let mixinCaughtErrors = 0;
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
            mixinCaughtErrors += 1;
            if (error instanceof Error) {
              warnings.push(`${configPath}: ${error.message}`);
            }
          }
        }
        const mixinDurationMs = Date.now() - mixinDurationStart;

        const awDurationStart = Date.now();
        let validAw = 0;
        let invalidAw = 0;
        let awCaughtErrors = 0;
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
            awCaughtErrors += 1;
            if (error instanceof Error) {
              warnings.push(error.message);
            }
          }
        }
        const awDurationMs = Date.now() - awDurationStart;

        const atDurationStart = Date.now();
        let validAt = 0;
        let invalidAt = 0;
        let atCaughtErrors = 0;
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
            atCaughtErrors += 1;
            if (error instanceof Error) {
              warnings.push(error.message);
            }
          }
        }
        const atDurationMs = Date.now() - atDurationStart;

        const invalidCount = invalidMixins + invalidAw + invalidAt;
        const partialCount = partialMixins;
        const status = invalidCount > 0 ? "invalid" : partialCount > 0 ? "partial" : "ok";

        const baseResult = buildEntryToolResult({
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
        });
        const tasks = await this.buildFullTaskStatusReport({
          projectPath,
          detail,
          include,
          resolvedVersion: validationVersion,
          mapping: input.mapping,
          sourcePriority: input.sourcePriority,
          scope: input.scope,
          preferProjectVersion: input.preferProjectVersion,
          mixinDiscoveryCount: mixinConfigs.length,
          mixinCaughtErrors,
          mixinCounts: { ok: validMixins, partial: partialMixins, invalid: invalidMixins },
          mixinDurationMs,
          awDiscoveryCount: accessWideners.length,
          awCaughtErrors,
          awCounts: { ok: validAw, invalid: invalidAw },
          awDurationMs,
          atDiscoveryCount: accessTransformers.length,
          atCaughtErrors,
          atCounts: { ok: validAt, invalid: invalidAt },
          atDurationMs
        });
        return {
          ...baseResult,
          ...(tasks ? { tasks } : {}),
          warnings
        };
      }
    }
  }
}
