import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isAppError } from "../../errors.js";
import { buildVersionSourceSearchRoots } from "../../gradle-paths.js";
import type { SourceMapping } from "../../types.js";

const VALIDATE_PROJECT_TASKS_OFF = process.env.VALIDATE_PROJECT_TASKS_OFF === "1";

type TaskStatus = "ok" | "skipped" | "missing" | "error";

type TaskEntryBase = {
  status: TaskStatus;
  durationMs?: number;
  error?: { code: string; detail: string };
  warnings?: string[];
};

type TaskStatusReport = {
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
] as const satisfies ReadonlyArray<keyof TaskStatusReport>;

export type ValidateProjectDeps = {
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

// Helpers live as free functions so ValidateProjectService keeps its baseline
// declaration surface (constructor + execute only).

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
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

export async function runUpstreamProbes(projectPath: string): Promise<{
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

export async function buildEarlyTasksForBlocked(
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
  const { workspace, gradle, loom } = await runUpstreamProbes(projectPath);
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

export async function buildFullTaskStatusReport(
  deps: ValidateProjectDeps,
  args: {
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
  }
): Promise<TaskStatusReport | undefined> {
  if (VALIDATE_PROJECT_TASKS_OFF) {
    return undefined;
  }
  const { workspace, gradle, loom } = await runUpstreamProbes(args.projectPath);
  let minecraftArtifactResolved: TaskStatusReport["minecraft.artifact.resolved"];
  if (workspace.status !== "ok" || gradle.status !== "ok") {
    minecraftArtifactResolved = { status: "skipped" };
  } else if (deps.resolveArtifact) {
    minecraftArtifactResolved = await probeMinecraftArtifactResolved(deps.resolveArtifact, {
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
