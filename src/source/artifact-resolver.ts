import fastGlob from "fast-glob";

import { buildArtifactAlias } from "../config.js";
import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError, isAppError } from "../errors.js";
import {
  buildLoaderRuntimeSearchRoots,
  buildVersionSourceSearchRoots,
  normalizeOptionalProjectPath
} from "../gradle-paths.js";
import { log } from "../logger.js";
import { applyMappingPipeline } from "../mapping-pipeline-service.js";
import { parseCoordinate } from "../maven-resolver.js";
import { resolveMojangTinyFile } from "../mojang-tiny-mapping-service.js";
import { artifactSignatureFromFile } from "../path-resolver.js";
import {
  detectFabricLikeInputNamespace,
  listJavaEntries
} from "../source-jar-reader.js";
import {
  artifactIdForJar,
  type MappingVariant,
  resolveSourceTarget as resolveSourceTargetInternal
} from "../source-resolver.js";
import type { SourceService } from "../source-service.js";
import type {
  ArtifactContentsSummary,
  ProbeMinecraftArtifactInput,
  ProbeMinecraftArtifactOutput,
  ResolveArtifactInput,
  ResolveArtifactOutput
} from "../source-service.js";
import { resolveTinyRemapperJar } from "../tiny-remapper-resolver.js";
import type {
  AccessTransformerNamespace,
  ArtifactProvenance,
  ArtifactScope,
  ArtifactTargetKind,
  DependencyResolutionProvenance,
  MappingSourcePriority,
  ResolvedSourceArtifact,
  RuntimeLoader,
  RuntimeValidationProvenance,
  SourceMapping,
  SourceTargetInput,
  WorkspaceResolutionProvenance
} from "../types.js";
import { isUnobfuscatedVersion } from "../version-service.js";
import type { WorkspaceProjectLoader } from "../workspace-mapping-service.js";
import * as indexer from "./indexer.js";
import { dedupeQualityFlags, normalizeMapping, normalizeOptionalString, normalizePathStyle } from "./shared-utils.js";

type VersionSourceCandidate = {
  jarPath: string;
  javaEntryCount: number;
  hasMinecraftNamespace: boolean;
  looksLikeMinecraftArtifact: boolean;
  score: number;
};

/**
 * The Maven group under which the Minecraft runtime artifact itself is published
 * (`net.minecraft:client`, `net.minecraft:server`, the Loom merged jars). A
 * coordinate in this group carries a real Minecraft version in its version
 * segment; a coordinate in any other group carries a third-party library's own
 * release number, which says nothing about Minecraft.
 */
const MINECRAFT_ARTIFACT_GROUP_ID = "net.minecraft";

export type VersionSourceDiscovery = {
  searchedPaths: string[];
  candidateArtifacts: string[];
  selectedSourceJarPath?: string;
  selectedHasMinecraftNamespace?: boolean;
  /** The other half of a Loom split-source pair (common/clientOnly), when present. */
  companionSourceJarPaths?: string[];
};

type RuntimeJarCandidate = {
  jarPath: string;
  score: number;
  appliedScope: ArtifactScope;
  origin: RuntimeValidationProvenance["origin"];
  namespaceHint?: "intermediary" | "mojang" | "named";
  /** How the candidate was tied to the requested Minecraft version. */
  versionEvidence?: RuntimeVersionEvidence;
};

/**
 * Why a runtime jar is believed to belong to the requested Minecraft version.
 *
 * - `exact-token`: the Minecraft version appears verbatim in the path.
 * - `loader-token`: the path carries the loader version that maps 1:1 onto the
 *   Minecraft version (NeoForge `21.11.x` <-> Minecraft `1.21.11`).
 * - `project-anchored`: the jar sits inside the caller's own project build
 *   directory and the project declares exactly the requested Minecraft version.
 */
export type RuntimeVersionEvidence = "exact-token" | "loader-token" | "project-anchored";

export type MappingFallbackSuggestion = {
  suggestedCall?: { tool: string; params: Record<string, unknown> };
  exampleCalls?: Array<{ tool: string; params: Record<string, unknown>; reason: string }>;
  nextAction: string;
  _suggestedCallPrimaryDropped?: boolean;
};

const VERSION_TOKEN_REGEX_CACHE = new Map<string, RegExp>();
const LOADER_VERSION_TOKEN_REGEX_CACHE = new Map<string, RegExp>();
const MAX_HELPER_REGEX_CACHE = 128;

function rememberCachedRegex(cache: Map<string, RegExp>, key: string, regex: RegExp): RegExp {
  if (cache.size >= MAX_HELPER_REGEX_CACHE) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, regex);
  return regex;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPartialNetMinecraftCoverage(qualityFlags: string[]): boolean {
  return qualityFlags.includes("partial-source-no-net-minecraft");
}

function looksLikeMinecraftSourceArtifact(path: string, hasMinecraftNamespace: boolean): boolean {
  if (hasMinecraftNamespace) {
    return true;
  }

  const normalizedPath = normalizePathStyle(path).toLowerCase();
  return (
    normalizedPath.includes("/minecraftmaven/") ||
    normalizedPath.includes("/net/minecraft/") ||
    /(?:^|\/)minecraft(?:-[a-z0-9._+]+)*-sources\.jar$/i.test(normalizedPath) ||
    normalizedPath.includes("minecraft-merged") ||
    normalizedPath.includes("minecraft-common") ||
    normalizedPath.includes("minecraft-clientonly") ||
    normalizedPath.includes("minecraft-client") ||
    normalizedPath.includes("minecraft-server")
  );
}

export function hasExactVersionToken(path: string, version: string): boolean {
  const normalizedPath = normalizePathStyle(path).toLowerCase();
  const normalizedVersion = version.trim().toLowerCase();
  if (!normalizedVersion) {
    return false;
  }
  // Avoid prefix false-positives like "1.21.1" matching "1.21.10".
  const cached = VERSION_TOKEN_REGEX_CACHE.get(normalizedVersion);
  const pattern =
    cached
    ?? rememberCachedRegex(
      VERSION_TOKEN_REGEX_CACHE,
      normalizedVersion,
      new RegExp(`(^|[^0-9a-z])${escapeRegexLiteral(normalizedVersion)}(?![0-9a-z]|\\.[0-9])`, "i")
    );
  return pattern.test(normalizedPath);
}

/**
 * True when a path carries the NeoForge/Forge loader version that corresponds
 * 1:1 to `mcVersion`.
 *
 * ModDevGradle names every artifact after the LOADER version and never after
 * Minecraft: MC 1.21.11 produces `build/moddev/artifacts/neoforge-21.11.38-beta-merged.jar`.
 * A plain `hasExactVersionToken(path, "1.21.11")` therefore rejected every
 * artifact of the canonical NeoForge workspace, which made
 * validate-access-transformer unusable there.
 *
 * NeoForge derives its version from Minecraft as `<minor>.<patch>.<build>`, so
 * `1.21.11` -> `21.11.<build>` and `1.21` -> `21.0.<build>`. The trailing dot
 * before the build number keeps `21.1.` from matching `21.10.5`.
 */
export function hasLoaderRuntimeVersionToken(path: string, mcVersion: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion.trim());
  if (!match) {
    return false;
  }
  const minor = match[1];
  const patch = match[2] ?? "0";
  const normalizedPath = normalizePathStyle(path).toLowerCase();
  const cacheKey = `loader:${minor}.${patch}`;
  const pattern =
    LOADER_VERSION_TOKEN_REGEX_CACHE.get(cacheKey)
    ?? rememberCachedRegex(
      LOADER_VERSION_TOKEN_REGEX_CACHE,
      cacheKey,
      new RegExp(`(^|[^0-9a-z.])${minor}\\.${patch}\\.\\d`, "i")
    );
  return pattern.test(normalizedPath);
}

const RUNTIME_JAR_VERSION_REGEX = /(?:^|[^0-9.])(1\.\d+(?:\.\d+)?)(?![0-9.])/;

/**
 * Minecraft version a runtime jar path carries, or undefined when the path
 * names none. Loom lays its cache out as
 * `<gradle>/caches/fabric-loom/<mcVersion>/...`, so the first `1.x[.y]` token
 * of the path is the version the jar was built for.
 */
export function inferRuntimeJarMinecraftVersion(path: string): string | undefined {
  return RUNTIME_JAR_VERSION_REGEX.exec(normalizePathStyle(path))?.[1];
}

/**
 * Loader a runtime jar belongs to, read from its path.
 *
 * A Loom cache holds NeoForge-patched jars under a `/neoforge/` segment
 * (`caches/fabric-loom/1.21.10/neoforge/21.10.50-beta/minecraft-merged-mojang-at-patched.jar`).
 * Serving one of those to a Fabric workspace silently validated a Fabric access
 * widener against NeoForge bytecode, so the loader has to travel with the jar.
 */
export function inferRuntimeJarLoader(path: string): RuntimeLoader {
  const lower = normalizePathStyle(path).toLowerCase();
  if (lower.includes("neoforge") || lower.includes("neoform") || lower.includes("moddev")) {
    return "neoforge";
  }
  if (/(^|[/\-_])forge([/\-_.]|$)/.test(lower) || lower.includes("forge_gradle") || lower.includes("srg")) {
    return "forge";
  }
  if (lower.includes("fabric-loom") || lower.includes("loom-cache") || lower.includes("intermediary")) {
    return "fabric";
  }
  return "unknown";
}

/**
 * Fills in the truthful version/loader half of a runtime provenance record.
 *
 * `version` becomes the version the SERVED jar carries; the caller's original
 * request is preserved under `requestedVersion` and flagged. A served loader
 * that contradicts a KNOWN expected loader is flagged too — never silently
 * dropped.
 */
export function describeServedRuntimeJar(input: {
  jarPath: string;
  requestedVersion: string;
  expectedLoader?: RuntimeLoader;
}): {
  version: string;
  requestedVersion?: string;
  versionApproximated?: boolean;
  servedLoader: RuntimeLoader;
  expectedLoader?: RuntimeLoader;
  loaderMismatch?: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  const servedVersion = inferRuntimeJarMinecraftVersion(input.jarPath);
  const versionApproximated =
    servedVersion !== undefined && servedVersion !== input.requestedVersion.trim();
  const servedLoader = inferRuntimeJarLoader(input.jarPath);
  const expectedLoader = input.expectedLoader;
  const loaderMismatch =
    expectedLoader !== undefined &&
    expectedLoader !== "unknown" &&
    servedLoader !== "unknown" &&
    servedLoader !== expectedLoader;

  if (versionApproximated) {
    notes.push(
      `Runtime jar is Minecraft ${servedVersion}, not the requested ${input.requestedVersion}; results are approximate.`
    );
  }
  if (loaderMismatch) {
    notes.push(
      `Runtime jar is a ${servedLoader} artifact while the workspace is ${expectedLoader}; its bytecode differs from the ${expectedLoader} runtime.`
    );
  }

  return {
    version: versionApproximated && servedVersion ? servedVersion : input.requestedVersion,
    ...(versionApproximated ? { requestedVersion: input.requestedVersion, versionApproximated: true } : {}),
    servedLoader,
    ...(expectedLoader ? { expectedLoader } : {}),
    ...(loaderMismatch ? { loaderMismatch: true } : {}),
    notes
  };
}

function inferMergedRuntimeNamespaceHint(
  path: string
): RuntimeJarCandidate["namespaceHint"] {
  const normalizedPath = normalizePathStyle(path).toLowerCase();
  if (
    normalizedPath.includes("merged-intermediary-v2") ||
    normalizedPath.includes("merged-intermediary")
  ) {
    return "intermediary";
  }
  if (
    normalizedPath.includes("minecraft-merged-mojang") ||
    normalizedPath.includes("merged-mojang")
  ) {
    return "mojang";
  }
  if (normalizedPath.includes("merged-named")) {
    return "named";
  }
  return undefined;
}

function runtimeJarNamespaceHintScore(hint: RuntimeJarCandidate["namespaceHint"]): number {
  if (hint === "intermediary" || hint === "mojang") {
    return 8_000;
  }
  if (hint === "named") {
    return 1_000;
  }
  return 0;
}

function normalizeAccessTransformerNamespace(
  namespace: AccessTransformerNamespace | string | undefined
): AccessTransformerNamespace | undefined {
  const normalized = namespace?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "srg" || normalized === "mojang" || normalized === "obfuscated") {
    return normalized;
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildResolveArtifactParams(
  target: SourceTargetInput,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    target: {
      kind: target.kind,
      value: target.value
    },
    ...extra
  };
}

function buildProvenance(input: {
  requestedTarget: SourceTargetInput;
  resolved: ResolvedSourceArtifact;
  transformChain: string[];
}): ArtifactProvenance {
  const provenance: ArtifactProvenance = {
    target: input.requestedTarget,
    resolvedAt: input.resolved.resolvedAt,
    resolvedFrom: {
      origin: input.resolved.origin,
      sourceJarPath: input.resolved.sourceJarPath,
      binaryJarPath: input.resolved.binaryJarPath,
      coordinate: input.resolved.coordinate,
      version: input.resolved.version,
      repoUrl: input.resolved.repoUrl
    },
    transformChain: [...input.transformChain]
  };

  if (!provenance.resolvedAt || !provenance.target.kind || !provenance.target.value) {
    throw createError({
      code: ERROR_CODES.PROVENANCE_INCOMPLETE,
      message: "Artifact provenance is incomplete.",
      details: {
        artifactId: input.resolved.artifactId,
        provenance
      }
    });
  }

  return provenance;
}

export async function discoverVersionSourceJar(_svc: SourceService, input: {
  version: string;
  projectPath?: string;
  gradleUserHome?: string;
}): Promise<VersionSourceDiscovery> {
  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  const searchRoots = buildVersionSourceSearchRoots({
    projectPath: normalizedProjectPath,
    gradleUserHome: input.gradleUserHome
  });
  const searchedPaths: string[] = [];
  const candidates: VersionSourceCandidate[] = [];
  const seen = new Set<string>();

  for (const root of searchRoots) {
    searchedPaths.push(root);
    let discovered: string[] = [];
    try {
      discovered = await fastGlob.glob("**/*sources.jar", {
        cwd: root,
        absolute: true,
        onlyFiles: true
      });
    } catch {
      continue;
    }

    for (const candidatePath of discovered) {
      const normalizedPath = normalizePathStyle(candidatePath);
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);
      const lower = normalizedPath.toLowerCase();
      if (!lower.includes(input.version.toLowerCase()) && !lower.includes("minecraft")) {
        continue;
      }

      let javaEntries: string[] = [];
      try {
        javaEntries = await listJavaEntries(normalizedPath);
      } catch {
        continue;
      }
      if (javaEntries.length === 0) {
        continue;
      }

      const hasMinecraftNamespace = javaEntries.some((entry) =>
        normalizePathStyle(entry).startsWith("net/minecraft/")
      );
      const looksLikeMinecraftArtifact = looksLikeMinecraftSourceArtifact(
        normalizedPath,
        hasMinecraftNamespace
      );
      const exactVersionMatch = hasExactVersionToken(normalizedPath, input.version);
      const score =
        (looksLikeMinecraftArtifact ? 20_000 : 0) +
        (hasMinecraftNamespace ? 10_000 : 0) +
        (lower.includes("minecraft-merged") ? 2_000 : 0) +
        (exactVersionMatch ? 1_000 : 0) +
        Math.min(javaEntries.length, 500);
      candidates.push({
        jarPath: normalizedPath,
        javaEntryCount: javaEntries.length,
        hasMinecraftNamespace,
        looksLikeMinecraftArtifact,
        score
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.jarPath.localeCompare(right.jarPath);
  });

  const selected =
    candidates.find((candidate) => candidate.looksLikeMinecraftArtifact && candidate.hasMinecraftNamespace) ??
    candidates.find((candidate) => candidate.looksLikeMinecraftArtifact);
  const candidateArtifacts = candidates
    .slice(0, 20)
    .map((candidate) => `${candidate.jarPath}#java=${candidate.javaEntryCount}#net_minecraft=${candidate.hasMinecraftNamespace ? 1 : 0}`);

  // Loom split-source workspaces publish the version as a common/clientOnly
  // PAIR with no merged jar; selecting one loses the other half's classes
  // (e.g. net.minecraft.client.* when common wins). Surface the best-scored
  // jar of the other half so ingestion can index both.
  const selectedHalf = selected ? splitSourceHalf(selected.jarPath) : undefined;
  const companion = selectedHalf
    ? candidates.find(
        (candidate) =>
          candidate !== selected &&
          candidate.looksLikeMinecraftArtifact &&
          splitSourceHalf(candidate.jarPath) !== undefined &&
          splitSourceHalf(candidate.jarPath) !== selectedHalf &&
          // Version affinity: a leftover other-half jar from a different
          // version must never be spliced into this version's index.
          hasExactVersionToken(candidate.jarPath, input.version)
      )
    : undefined;

  return {
    searchedPaths,
    candidateArtifacts,
    selectedSourceJarPath: selected?.jarPath,
    selectedHasMinecraftNamespace: selected?.hasMinecraftNamespace,
    ...(companion ? { companionSourceJarPaths: [companion.jarPath] } : {})
  };
}

function splitSourceHalf(jarPath: string): "common" | "clientonly" | undefined {
  const match = /minecraft-(common|clientonly)/i.exec(jarPath);
  return match ? (match[1]!.toLowerCase() as "common" | "clientonly") : undefined;
}

export async function probeMinecraftArtifact(
  svc: SourceService,
  input: ProbeMinecraftArtifactInput
): Promise<ProbeMinecraftArtifactOutput> {
  let value = input.target.value.trim();
  const warnings: string[] = [];
  const requestedMapping = normalizeMapping(input.mapping);

  if (input.preferProjectVersion && input.projectPath) {
    const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
    if (detected && detected !== value) {
      warnings.push(`Overriding version "${value}" with project version "${detected}" from gradle.properties.`);
    }
    value = detected ?? value;
  }
  if (!value) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "target.value must be non-empty.",
      details: { target: input.target }
    });
  }

  const versionJar = await svc.versionService.resolveVersionJar(value);
  const resolvedVersion = versionJar.version;
  const runtimeNamesUnobfuscated = isUnobfuscatedVersion(resolvedVersion);
  warnings.push(`Resolved Minecraft ${versionJar.version} from ${versionJar.clientJarUrl}.`);

  let effectiveMapping: SourceMapping = requestedMapping;
  if (
    (requestedMapping === "intermediary" || requestedMapping === "yarn") &&
    runtimeNamesUnobfuscated
  ) {
    warnings.push(
      `Version ${resolvedVersion} is unobfuscated; ${requestedMapping} mappings are not applicable. Using the obfuscated namespace label for the deobfuscated runtime names.`
    );
    effectiveMapping = "obfuscated";
  }

  if (
    (effectiveMapping === "intermediary" || effectiveMapping === "yarn") &&
    !runtimeNamesUnobfuscated
  ) {
    throw createError({
      code: ERROR_CODES.MAPPING_NOT_APPLIED,
      message:
        `Lightweight artifact probe cannot verify ${effectiveMapping} mapping availability without running the full resolver.`,
      details: {
        requestedMapping: effectiveMapping,
        version: resolvedVersion,
        nextAction:
          "Use a direct validation task for mapping-sensitive checks, or use mapping=obfuscated for the project-summary artifact probe."
      }
    });
  }

  if (effectiveMapping === "mojang" && !runtimeNamesUnobfuscated) {
    // Match validate-mixin's resolve stage: omitted scope defaults to vanilla,
    // avoiding a workspace-wide source-jar scan that validate-mixin would skip.
    const effectiveScope = input.scope ?? "vanilla";
    if (effectiveScope === "vanilla") {
      throw createError({
        code: ERROR_CODES.MAPPING_NOT_APPLIED,
        message:
          "Lightweight artifact probe cannot verify mojang mapping with scope=vanilla on obfuscated runtime versions.",
        details: {
          requestedMapping: effectiveMapping,
          version: resolvedVersion,
          nextAction:
            "Retry with scope=merged and projectPath so the probe can use a Loom source jar, or use mapping=obfuscated."
        }
      });
    }

    const versionSourceDiscovery = await svc.discoverVersionSourceJar({
      version: resolvedVersion,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome
    });
    if (!versionSourceDiscovery.selectedSourceJarPath) {
      throw createError({
        code: ERROR_CODES.MAPPING_NOT_APPLIED,
        message:
          "Lightweight artifact probe cannot verify mojang mapping without a source-backed Loom artifact.",
        details: {
          requestedMapping: effectiveMapping,
          version: resolvedVersion,
          searchedPaths: versionSourceDiscovery.searchedPaths,
          candidateArtifacts: versionSourceDiscovery.candidateArtifacts,
          nextAction:
            "Use mapping=obfuscated for project-summary, or run a direct validation task when full source resolution is required."
        }
      });
    }

    const selectedSourceJarPath = versionSourceDiscovery.selectedSourceJarPath;
    const sourceSignature = artifactSignatureFromFile(selectedSourceJarPath).signature;
    const artifactId = artifactIdForJar("jar", selectedSourceJarPath, sourceSignature);
    warnings.push(`Resolved source-backed artifact from Loom cache candidate: ${selectedSourceJarPath}.`);
    if (versionSourceDiscovery.selectedHasMinecraftNamespace === false) {
      warnings.push(
        `Source coverage does not include net.minecraft for ${selectedSourceJarPath}; class lookups may fall back to the binary artifact.`
      );
    }
    if (!hasExactVersionToken(selectedSourceJarPath, value)) {
      warnings.push(
        `Requested version "${value}" but resolved source jar does not contain exact version string: ${selectedSourceJarPath}`
      );
    }

    return {
      artifactId,
      mappingApplied: "mojang",
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  const binarySignature = artifactSignatureFromFile(versionJar.jarPath).signature;
  const artifactId = artifactIdForJar("jar", versionJar.jarPath, `${binarySignature}:decompile`);
  return {
    artifactId,
    mappingApplied: effectiveMapping,
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export async function discoverAccessWidenerRuntimeCandidates(_svc: SourceService, input: {
  version: string;
  projectPath?: string;
  gradleUserHome?: string;
  requestedScope: ArtifactScope;
}): Promise<{ searchedPaths: string[]; candidateArtifacts: string[]; selected?: RuntimeJarCandidate }> {
  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  const normalizedProjectPathLower = normalizedProjectPath
    ? normalizePathStyle(normalizedProjectPath).toLowerCase()
    : undefined;
  const searchRoots = buildVersionSourceSearchRoots({
    projectPath: normalizedProjectPath,
    gradleUserHome: input.gradleUserHome
  });
  const searchedPaths: string[] = [];
  const candidates: RuntimeJarCandidate[] = [];
  const seen = new Set<string>();

  for (const root of searchRoots) {
    searchedPaths.push(root);
    let discovered: string[] = [];
    try {
      discovered = await fastGlob.glob(["**/*minecraft*.jar", "**/*merged*.jar"], {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/*sources.jar", "**/node_modules/**", "**/.git/**", "**/build/**", "**/out/**"]
      });
    } catch {
      continue;
    }

    for (const candidatePath of discovered) {
      const normalizedPath = normalizePathStyle(candidatePath);
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);

      const lower = normalizedPath.toLowerCase();
      if (!lower.includes("minecraft")) {
        continue;
      }

      const exactVersionMatch = hasExactVersionToken(normalizedPath, input.version);
      const looksMerged = lower.includes("minecraft-merged") || lower.includes("/merged/") || lower.includes("-merged");
      const namespaceHint = inferMergedRuntimeNamespaceHint(normalizedPath);
      const appliedScope: ArtifactScope =
        looksMerged
          ? "merged"
          : input.requestedScope === "loader"
            ? "merged"
            : input.requestedScope;

      const score =
        (exactVersionMatch ? 5_000 : 0) +
        (looksMerged ? 4_000 : 0) +
        runtimeJarNamespaceHintScore(namespaceHint) +
        (normalizedProjectPathLower && lower.startsWith(normalizedProjectPathLower) ? 2_000 : 0) +
        (lower.includes("loom-cache") || lower.includes("/caches/fabric-loom/") ? 500 : 0) +
        (lower.includes("minecraft-client") || lower.includes("client") ? 100 : 0);

      candidates.push({
        jarPath: normalizedPath,
        score,
        appliedScope,
        origin:
          lower.includes("loom-cache") || lower.includes("/caches/fabric-loom/")
            ? "loom-cache"
            : "local-jar",
        namespaceHint
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.jarPath.localeCompare(right.jarPath);
  });

  return {
    searchedPaths,
    candidateArtifacts: candidates.slice(0, 20).map((candidate) => candidate.jarPath),
    selected: candidates[0]
  };
}

export async function discoverAccessTransformerRuntimeCandidates(_svc: SourceService, input: {
  version: string;
  projectPath?: string;
  gradleUserHome?: string;
  requestedScope: ArtifactScope;
  atNamespace: AccessTransformerNamespace;
  loader: WorkspaceProjectLoader | "unknown";
  /** Minecraft version the workspace itself declares, when it could be read. */
  projectMinecraftVersion?: string;
}): Promise<{ searchedPaths: string[]; candidateArtifacts: string[]; selected?: RuntimeJarCandidate }> {
  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  const normalizedProjectPathLower = normalizedProjectPath
    ? normalizePathStyle(normalizedProjectPath).toLowerCase()
    : undefined;
  // A jar inside the caller's own build directory belongs to the version that
  // workspace declares, whatever its filename says.
  const projectAnchorAllowed =
    normalizedProjectPathLower !== undefined &&
    input.projectMinecraftVersion !== undefined &&
    input.projectMinecraftVersion.trim() === input.version.trim();
  const searchRoots = buildLoaderRuntimeSearchRoots({
    projectPath: normalizedProjectPath,
    gradleUserHome: input.gradleUserHome
  });
  const searchedPaths: string[] = [];
  const candidates: RuntimeJarCandidate[] = [];
  const seen = new Set<string>();

  const globs = [
    "**/*minecraft*.jar",
    "**/*patched*.jar",
    "**/*srg*.jar",
    "**/*joined*.jar",
    "**/*client-extra*.jar",
    "**/*forge*.jar",
    "**/*neoforge*.jar",
    "**/*moddev*.jar",
    "**/*neoform*.jar"
  ];

  for (const root of searchRoots) {
    searchedPaths.push(root);
    if (!(await pathExists(root))) {
      continue;
    }
    let discovered: string[] = [];
    try {
      discovered = await fastGlob.glob(globs, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/*sources.jar", "**/node_modules/**", "**/.git/**", "**/out/**"]
      });
    } catch {
      continue;
    }

    for (const candidatePath of discovered) {
      const normalizedPath = normalizePathStyle(candidatePath);
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);

      const lower = normalizedPath.toLowerCase();
      const insideProject = normalizedProjectPathLower !== undefined && lower.startsWith(normalizedProjectPathLower);
      // Positive version evidence is REQUIRED; the three forms are ranked so a
      // verbatim Minecraft version always beats an inferred one.
      const versionEvidence: RuntimeVersionEvidence | undefined = hasExactVersionToken(
        normalizedPath,
        input.version
      )
        ? "exact-token"
        : hasLoaderRuntimeVersionToken(normalizedPath, input.version)
          ? "loader-token"
          : projectAnchorAllowed && insideProject
            ? "project-anchored"
            : undefined;
      if (!versionEvidence) {
        continue;
      }

      const looksMerged = lower.includes("merged");
      const looksSrg = lower.includes("srg");
      const looksForge = lower.includes("forge");
      const looksNeoForge = lower.includes("neoforge") || lower.includes("moddev") || lower.includes("neoform");
      const looksPatchedRuntime = lower.includes("patched") || lower.includes("client-extra") || lower.includes("joined");
      // client-extra / *-minecraft-resources jars carry resources ONLY, so they
      // can never answer a class lookup. They stay selectable (a workspace that
      // has nothing else still gets an answer) but must lose to any real
      // classes jar.
      const looksResourcesOnly = lower.includes("client-extra") || lower.includes("minecraft-resources");
      const appliedScope: ArtifactScope =
        looksMerged
          ? "merged"
          : "loader";

      if (input.atNamespace === "srg" && !looksSrg) {
        continue;
      }
      if (input.loader === "forge" && !looksForge && !looksSrg && !looksPatchedRuntime) {
        continue;
      }
      if (input.loader === "neoforge" && !looksNeoForge && !looksPatchedRuntime && !lower.includes("minecraft")) {
        continue;
      }

      const score =
        10_000 +
        (versionEvidence === "exact-token" ? 5_000 : versionEvidence === "loader-token" ? 3_500 : 3_000) +
        (insideProject ? 4_000 : 0) +
        (looksPatchedRuntime ? 3_000 : 0) +
        (looksSrg ? 2_500 : 0) +
        (input.loader === "forge" && looksForge ? 1_500 : 0) +
        (input.loader === "neoforge" && looksNeoForge ? 1_500 : 0) +
        (input.requestedScope === appliedScope ? 1_000 : 0) +
        (looksMerged ? -500 : 0) +
        (looksResourcesOnly ? -6_000 : 0);

      candidates.push({
        jarPath: normalizedPath,
        score,
        appliedScope,
        origin: "local-jar",
        versionEvidence
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.jarPath.localeCompare(right.jarPath);
  });

  return {
    searchedPaths,
    candidateArtifacts: candidates.slice(0, 20).map((candidate) => candidate.jarPath),
    selected: candidates[0]
  };
}

export async function resolveAccessWidenerRuntimeArtifact(svc: SourceService, input: {
  version: string;
  awNamespace: SourceMapping;
  projectPath?: string;
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
}): Promise<RuntimeValidationProvenance<SourceMapping>> {
  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  let version = input.version;
  if (input.preferProjectVersion && normalizedProjectPath) {
    const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(normalizedProjectPath);
    version = detected ?? version;
  }

  const expectedLoader: RuntimeLoader | undefined = normalizedProjectPath
    ? await detectWorkspaceRuntimeLoader(svc, normalizedProjectPath)
    : undefined;

  const requestedScope: ArtifactScope = input.scope ?? (normalizedProjectPath ? "loader" : "vanilla");
  if (requestedScope === "vanilla") {
    const versionJar = await svc.versionService.resolveVersionJar(version);
    return {
      version: versionJar.version,
      jarPath: versionJar.jarPath,
      requestedScope,
      appliedScope: "vanilla",
      requestedMapping: input.awNamespace,
      mappingApplied: "obfuscated",
      origin: "version-jar"
    };
  }

  const discovery = await svc.discoverAccessWidenerRuntimeCandidates({
    version,
    projectPath: normalizedProjectPath,
    gradleUserHome: input.gradleUserHome,
    requestedScope
  });
  if (!discovery.selected) {
    throw createError({
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      message: "Could not resolve a runtime jar for Access Widener validation.",
      details: {
        version,
        requestedScope,
        projectPath: normalizedProjectPath,
        searchedPaths: discovery.searchedPaths,
        candidateArtifacts: discovery.candidateArtifacts,
        nextAction: "Provide projectPath for a Loom workspace with generated runtime jars, or run Gradle tasks that populate the Loom cache before retrying.",
        ...buildSuggestedCall({
          tool: "validate-access-widener",
          params: {
            version,
            scope: requestedScope,
            ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {})
          }
        })
      }
    });
  }

  const appliedScope = discovery.selected.appliedScope;
  const scopeFallback =
    requestedScope !== appliedScope
      ? {
          requested: requestedScope,
          applied: appliedScope,
          reason: requestedScope === "loader"
            ? "Fabric loader runtime validation currently reuses the merged runtime jar."
            : "Selected runtime jar matched a nearby merged artifact."
        }
      : undefined;

  let detectedMapping: "obfuscated" | "intermediary" | "mojang";
  const notes: string[] = [];
  if (scopeFallback) {
    notes.push(scopeFallback.reason);
  }
  if (isUnobfuscatedVersion(version)) {
    detectedMapping = "obfuscated";
  } else if (
    discovery.selected.namespaceHint === "intermediary" ||
    discovery.selected.namespaceHint === "mojang"
  ) {
    detectedMapping = discovery.selected.namespaceHint;
  } else {
    const detection = await detectFabricLikeInputNamespace(discovery.selected.jarPath);
    detectedMapping = detection.fromNamespace;
    if (detection.warnings.length > 0) {
      notes.push(...detection.warnings);
    }
  }

  // Provenance must describe the jar that was SERVED, never the request.
  const served = describeServedRuntimeJar({
    jarPath: discovery.selected.jarPath,
    requestedVersion: version,
    expectedLoader
  });
  notes.push(...served.notes);

  return {
    version: served.version,
    jarPath: discovery.selected.jarPath,
    ...(served.requestedVersion ? { requestedVersion: served.requestedVersion } : {}),
    ...(served.versionApproximated ? { versionApproximated: true } : {}),
    servedLoader: served.servedLoader,
    ...(served.expectedLoader ? { expectedLoader: served.expectedLoader } : {}),
    ...(served.loaderMismatch ? { loaderMismatch: true } : {}),
    requestedScope,
    appliedScope,
    requestedMapping: input.awNamespace,
    mappingApplied: detectedMapping,
    origin: discovery.selected.origin,
    resolutionNotes: notes.length > 0 ? notes : undefined,
    scopeFallback
  };
}

/**
 * Loader a workspace declares, normalized onto {@link RuntimeLoader}. Quilt is
 * Fabric-compatible for runtime-jar purposes; anything undetected stays
 * "unknown" so no mismatch is ever asserted on a guess.
 */
async function detectWorkspaceRuntimeLoader(
  svc: SourceService,
  projectPath: string
): Promise<RuntimeLoader> {
  const detection = await svc.workspaceMappingService.detectProjectLoader(projectPath);
  if (!detection.resolved) {
    return "unknown";
  }
  switch (detection.loader) {
    case "fabric":
    case "quilt":
      return "fabric";
    case "forge":
      return "forge";
    case "neoforge":
      return "neoforge";
    default:
      return "unknown";
  }
}

export async function resolveAccessTransformerNamespace(svc: SourceService, input: {
  atNamespace?: AccessTransformerNamespace;
  projectPath?: string;
}): Promise<AccessTransformerNamespace> {
  const explicit = normalizeAccessTransformerNamespace(input.atNamespace);
  if (explicit) {
    return explicit;
  }

  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  if (!normalizedProjectPath) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "atNamespace is required when projectPath is not provided.",
      details: {
        nextAction: "Pass atNamespace explicitly, or provide projectPath for a Forge/NeoForge workspace so the namespace can be inferred."
      }
    });
  }

  const loaderDetection = await svc.workspaceMappingService.detectProjectLoader(normalizedProjectPath);
  if (loaderDetection.resolved && loaderDetection.loader === "forge") {
    return "srg";
  }
  if (loaderDetection.resolved && loaderDetection.loader === "neoforge") {
    return "mojang";
  }

  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "Could not infer atNamespace from the workspace.",
    details: {
      projectPath: normalizedProjectPath,
      evidence: loaderDetection.evidence,
      warnings: loaderDetection.warnings,
      nextAction: "Pass atNamespace explicitly, or point projectPath at a Forge/NeoForge workspace."
    }
  });
}

export async function resolveAccessTransformerRuntimeArtifact(svc: SourceService, input: {
  version: string;
  atNamespace: AccessTransformerNamespace;
  projectPath?: string;
  gradleUserHome?: string;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
}): Promise<RuntimeValidationProvenance<AccessTransformerNamespace>> {
  const normalizedProjectPath = normalizeOptionalProjectPath(input.projectPath);
  let version = input.version;
  // The workspace's own declared version is read whenever a project is given:
  // preferProjectVersion decides whether it OVERRIDES the requested version,
  // but discovery needs it either way to anchor project-local artifacts whose
  // filenames carry only a loader version.
  const projectMinecraftVersion = normalizedProjectPath
    ? await svc.workspaceMappingService.detectProjectMinecraftVersion(normalizedProjectPath)
    : undefined;
  if (input.preferProjectVersion && projectMinecraftVersion) {
    version = projectMinecraftVersion;
  }

  const requestedScope: ArtifactScope = input.scope ?? (normalizedProjectPath ? "loader" : "vanilla");
  if (requestedScope === "vanilla") {
    if (input.atNamespace === "srg") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved."
      });
    }
    const versionJar = await svc.versionService.resolveVersionJar(version);
    return {
      version: versionJar.version,
      jarPath: versionJar.jarPath,
      requestedScope,
      appliedScope: "vanilla",
      requestedMapping: input.atNamespace,
      mappingApplied: "obfuscated",
      origin: "version-jar"
    };
  }

  const loaderDetection = normalizedProjectPath
    ? await svc.workspaceMappingService.detectProjectLoader(normalizedProjectPath)
    : { resolved: false, loader: undefined, evidence: [], warnings: [] };
  const loader = loaderDetection.resolved ? loaderDetection.loader ?? "unknown" : "unknown";
  const discovery = await svc.discoverAccessTransformerRuntimeCandidates({
    version,
    projectPath: normalizedProjectPath,
    gradleUserHome: input.gradleUserHome,
    requestedScope,
    atNamespace: input.atNamespace,
    loader,
    projectMinecraftVersion
  });

  if (!discovery.selected) {
    throw createError({
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      message: "Could not resolve a runtime jar for Access Transformer validation.",
      details: {
        version,
        requestedScope,
        atNamespace: input.atNamespace,
        projectPath: normalizedProjectPath,
        searchedPaths: discovery.searchedPaths,
        candidateArtifacts: discovery.candidateArtifacts,
        loaderEvidence: loaderDetection.evidence,
        loaderWarnings: loaderDetection.warnings,
        ...(projectMinecraftVersion ? { projectMinecraftVersion } : {}),
        // An error must never ask for something the caller already sent.
        nextAction: normalizedProjectPath
          ? `Searched the workspace "${normalizedProjectPath}" and the Gradle caches but found no runtime jar for Minecraft ${version}${
              projectMinecraftVersion && projectMinecraftVersion !== version
                ? ` (the workspace declares ${projectMinecraftVersion}; retry with version="${projectMinecraftVersion}" or preferProjectVersion=true)`
                : ""
            }. Run the Gradle task that populates transformed runtime artifacts (NeoForge/ModDevGradle writes them under build/moddev/artifacts), then retry.`
          : "Provide projectPath for a Forge/NeoForge workspace with generated runtime jars, or run the Gradle tasks that populate transformed runtime artifacts before retrying."
      }
    });
  }

  const selected = discovery.selected;
  const selectedLower = selected.jarPath.toLowerCase();
  const mappingApplied: AccessTransformerNamespace =
    input.atNamespace === "srg" || selectedLower.includes("srg")
      ? "srg"
      : loader === "neoforge" || selectedLower.includes("moddev") || selectedLower.includes("neoforge")
        ? "mojang"
        : "obfuscated";
  const scopeFallback =
    requestedScope !== selected.appliedScope
      ? {
          requested: requestedScope,
          applied: selected.appliedScope,
          reason: selected.appliedScope === "merged"
            ? "Resolved a nearby merged runtime jar because no transformed loader artifact was available."
            : "Resolved the closest transformed runtime artifact for validation."
        }
      : undefined;

  const resolutionNotes = [
    ...(scopeFallback ? [scopeFallback.reason] : []),
    ...(selected.versionEvidence && selected.versionEvidence !== "exact-token"
      ? [
          selected.versionEvidence === "loader-token"
            ? `Runtime jar matched Minecraft ${version} through its loader version token (ModDevGradle names artifacts after the loader, not Minecraft).`
            : `Runtime jar matched Minecraft ${version} because it lives in the workspace build directory of a project declaring that version.`
        ]
      : [])
  ];

  const servedAt = describeServedRuntimeJar({
    jarPath: selected.jarPath,
    requestedVersion: version,
    // An access transformer is a Forge/NeoForge artifact; the workspace loader
    // refines that when it is known.
    expectedLoader: loader === "forge" ? "forge" : loader === "neoforge" ? "neoforge" : undefined
  });
  resolutionNotes.push(...servedAt.notes);

  return {
    version: servedAt.version,
    jarPath: selected.jarPath,
    ...(servedAt.requestedVersion ? { requestedVersion: servedAt.requestedVersion } : {}),
    ...(servedAt.versionApproximated ? { versionApproximated: true } : {}),
    servedLoader: servedAt.servedLoader,
    ...(servedAt.expectedLoader ? { expectedLoader: servedAt.expectedLoader } : {}),
    ...(servedAt.loaderMismatch ? { loaderMismatch: true } : {}),
    requestedScope,
    appliedScope: selected.appliedScope,
    requestedMapping: input.atNamespace,
    mappingApplied,
    origin: selected.origin,
    resolutionNotes: resolutionNotes.length > 0 ? resolutionNotes : undefined,
    scopeFallback
  };
}

export function inferVersionFromContext(input: {
  version?: string;
  provenance?: ArtifactProvenance;
  coordinate?: string;
}): string | undefined {
  const direct = normalizeOptionalString(input.version);
  if (direct) {
    return direct;
  }

  const resolvedFromVersion = normalizeOptionalString(input.provenance?.resolvedFrom.version);
  if (resolvedFromVersion) {
    return resolvedFromVersion;
  }

  if (input.provenance?.target.kind === "version") {
    const targetVersion = normalizeOptionalString(input.provenance.target.value);
    if (targetVersion) {
      return targetVersion;
    }
  }

  const coordinate = normalizeOptionalString(input.coordinate);
  if (coordinate) {
    try {
      return parseCoordinate(coordinate).version;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export async function resolveVersionContext(svc: SourceService, input: {
  version?: string;
  provenance?: ArtifactProvenance;
  coordinate?: string;
  projectPath?: string;
  preferProjectVersion?: boolean;
  warnings: string[];
}): Promise<string | undefined> {
  const inferredVersion = inferVersionFromContext(input);
  if (inferredVersion) {
    return inferredVersion;
  }

  if (!input.preferProjectVersion || !input.projectPath) {
    return undefined;
  }

  const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
  if (detected) {
    input.warnings.push(
      `Using project version "${detected}" from gradle.properties because the artifact metadata did not include a version.`
    );
  }
  return detected;
}

export async function resolveBinaryFallbackArtifact(svc: SourceService, input: {
  binaryJarPath?: string;
  version?: string;
  coordinate?: string;
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
  provenance?: ArtifactProvenance;
  qualityFlags: string[];
  /** Forwarded from the caller; unset keeps the historical decompile-on-demand behaviour. */
  allowDecompile?: boolean;
}): Promise<ResolvedSourceArtifact | undefined> {
  const binaryJarPath = normalizeOptionalString(input.binaryJarPath);
  if (!binaryJarPath) {
    return undefined;
  }

  try {
    const fallbackResolved = await resolveSourceTargetInternal(
      { kind: "jar", value: binaryJarPath },
      { allowDecompile: input.allowDecompile ?? true, preferBinaryOnly: true },
      svc.config
    );
    fallbackResolved.version = fallbackResolved.version ?? input.version;
    fallbackResolved.coordinate = fallbackResolved.coordinate ?? input.coordinate;
    fallbackResolved.requestedMapping = input.requestedMapping;
    fallbackResolved.mappingApplied = input.mappingApplied;
    fallbackResolved.provenance = input.provenance;
    fallbackResolved.qualityFlags = dedupeQualityFlags([
      ...(fallbackResolved.qualityFlags ?? []),
      ...input.qualityFlags,
      "binary-fallback"
    ]);
    await svc.ingestIfNeeded(fallbackResolved);
    return fallbackResolved;
  } catch {
    return undefined;
  }
}

function buildVersionSourceRecoveryCommand(projectPath?: string): string {
  const normalizedProjectPath = normalizeOptionalProjectPath(projectPath);
  const prefix = normalizedProjectPath
    ? `cd ${JSON.stringify(normalizedProjectPath)} && `
    : "";
  return `${prefix}./gradlew genSources --no-daemon`;
}

async function computeBinaryRemapGate(svc: SourceService, input: {
  requestedMapping: SourceMapping;
  runtimeNamesUnobfuscated: boolean;
  version: string | undefined;
  targetKind: ArtifactTargetKind;
  sourcePriority?: MappingSourcePriority;
  gradleUserHome?: string;
  forceBinaryRemapDisabled?: boolean;
}): Promise<{
  allowBinaryRemap: boolean;
  mappingVariant: MappingVariant;
  tinyRemapperJarPath?: string;
  mojangTinyFilePath?: string;
  warnings: string[];
}> {
  const baseline: {
    allowBinaryRemap: boolean;
    mappingVariant: MappingVariant;
    warnings: string[];
  } = {
    allowBinaryRemap: false,
    mappingVariant: "pass",
    warnings: []
  };

  if (input.forceBinaryRemapDisabled === true) {
    return baseline;
  }

  if (
    input.requestedMapping !== "mojang" ||
    input.runtimeNamesUnobfuscated ||
    !input.version
  ) {
    return baseline;
  }
  if (input.targetKind !== "version") {
    return baseline;
  }

  let tinyRemapperJarPath: string;
  try {
    tinyRemapperJarPath = await resolveTinyRemapperJar(
      svc.config.cacheDir,
      svc.config.tinyRemapperJarPath
    );
  } catch (caughtError) {
    log("warn", "binary-remap.gate.tiny-remapper-unavailable", {
      version: input.version,
      error: caughtError instanceof Error ? caughtError.message : String(caughtError)
    });
    return baseline;
  }

  let mojangTinyFilePath: string;
  try {
    const mojangTiny = await resolveMojangTinyFile(input.version, svc.config);
    mojangTinyFilePath = mojangTiny.path;
    if (mojangTiny.warnings.length > 0) {
      baseline.warnings.push(...mojangTiny.warnings);
    }
  } catch (caughtError) {
    log("warn", "binary-remap.gate.mojang-tiny-unavailable", {
      version: input.version,
      error: caughtError instanceof Error ? caughtError.message : String(caughtError)
    });
    return baseline;
  }

  let mojangAvailable = false;
  try {
    const health = await svc.mappingService.checkMappingHealth({
      version: input.version,
      requestedMapping: "mojang",
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome
    });
    mojangAvailable = health.mojangMappingsAvailable;
  } catch (caughtError) {
    log("warn", "binary-remap.gate.health-check-failed", {
      version: input.version,
      error: caughtError instanceof Error ? caughtError.message : String(caughtError)
    });
    return baseline;
  }

  if (!mojangAvailable) {
    return baseline;
  }

  return {
    allowBinaryRemap: true,
    mappingVariant: "mojang-remapped",
    tinyRemapperJarPath,
    mojangTinyFilePath,
    warnings: baseline.warnings
  };
}

/**
 * Describe what an artifact's indexed contents are.
 *
 * `sourceKind` is a derivation question — was the text produced by decompiling
 * bytecode? — and only the persisted `isDecompiled` flag answers it. `origin`
 * records provenance (where the bytes came from) and is deliberately not read:
 * the two axes disagree in practice, most visibly for a Jar-in-Jar shell, whose
 * row keeps origin "decompiled" while ingest clears the derivation flag. It
 * stays in the input shape only because every caller already carries it
 * alongside the fields that are read.
 */
export function buildArtifactContentsSummary(_svc: SourceService, input: {
  origin: ResolvedSourceArtifact["origin"];
  sourceJarPath?: string;
  isDecompiled: boolean;
  qualityFlags: string[];
}): ArtifactContentsSummary {
  const sourceKind =
    input.isDecompiled || !normalizeOptionalString(input.sourceJarPath)
      ? "decompiled-binary"
      : "source-jar";
  const sourceCoverage = hasPartialNetMinecraftCoverage(input.qualityFlags) ? "partial" : "full";

  return {
    sourceKind,
    indexedContentKinds: ["java-source"],
    resourcesIncluded: false,
    sourceCoverage
  };
}

export async function buildMappingFallbackSuggestedCall(svc: SourceService, args: {
  input: ResolveArtifactInput;
  kind: ArtifactTargetKind;
  value: string;
  scope: ArtifactScope | undefined;
  effectiveMapping: SourceMapping;
}): Promise<MappingFallbackSuggestion> {
  const { input, kind, value, scope, effectiveMapping } = args;
  const isVanillaMojang = scope === "vanilla" && effectiveMapping === "mojang";

  if (process.env.WORKSPACE_FALLBACK_LEGACY === "1") {
    return buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: input.projectPath });
  }

  const projectPath = input.projectPath?.trim();
  if (!projectPath) {
    return buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath: undefined });
  }

  if (kind !== "version") {
    return buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
  }

  const cached = svc.workspaceContextCache.read(projectPath);
  if (
    cached &&
    !cached.partial &&
    cached.compileMapping &&
    cached.compileMapping !== "obfuscated" &&
    cached.minecraftVersion === value
  ) {
    return {
      ...buildSuggestedCall({
        tool: "resolve-artifact",
        params: {
          target: { kind: "workspace" },
          projectPath,
          mapping: cached.compileMapping
        }
      }),
      nextAction: `Workspace at ${projectPath} maps as ${cached.compileMapping}. Retry with target.kind="workspace" to use the project's compile mapping.`
    };
  }

  if (!cached) {
    try {
      const detectedVersion = await svc.workspaceMappingService.detectProjectMinecraftVersion(projectPath);
      if (!detectedVersion || detectedVersion !== value) {
        return buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
      }
      const detection = await svc.workspaceMappingService.detectCompileMapping({ projectPath });
      if (detection.resolved && detection.mappingApplied && detection.mappingApplied !== "obfuscated") {
        const partial = {
          projectPath,
          minecraftVersion: detectedVersion,
          compileMapping: detection.mappingApplied,
          detectedAt: Date.now(),
          evidence: detection.evidence.map((entry) => ({
            source: entry.filePath,
            field: "compileMapping",
            value: entry.mapping
          })),
          dependencyVersions: new Map<string, string>(),
          partial: true
        };
        svc.workspaceContextCache.write(partial);
        return {
          ...buildSuggestedCall({
            tool: "resolve-artifact",
            params: {
              target: { kind: "workspace" },
              projectPath,
              mapping: detection.mappingApplied
            }
          }),
          nextAction: `Workspace at ${projectPath} maps as ${detection.mappingApplied}. Retry with target.kind="workspace" to use the project's compile mapping.`
        };
      }
    } catch {
      // bounded detection failed; fall back to legacy
    }
  }

  return buildLegacyMappingFallback({ kind, value, scope, isVanillaMojang, projectPath });
}

function buildLegacyMappingFallback(args: {
  kind: ArtifactTargetKind;
  value: string;
  scope: ArtifactScope | undefined;
  isVanillaMojang: boolean;
  projectPath: string | undefined;
}): MappingFallbackSuggestion {
  const { kind, value, scope, isVanillaMojang, projectPath } = args;
  if (isVanillaMojang && projectPath) {
    return {
      ...buildSuggestedCall({
        tool: "resolve-artifact",
        params: buildResolveArtifactParams(
          { kind, value },
          { mapping: "mojang", scope: "merged", projectPath }
        )
      }),
      nextAction:
        "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
        "Retry with scope=merged to allow source-jar resolution from the project cache."
    };
  }
  if (isVanillaMojang) {
    return {
      ...buildSuggestedCall({
        tool: "resolve-artifact",
        params: buildResolveArtifactParams(
          { kind, value },
          { mapping: "obfuscated", scope: "vanilla" }
        )
      }),
      nextAction:
        "scope=vanilla blocks Loom cache discovery needed for mojang mapping. " +
        "Without a projectPath, use mapping=obfuscated to read vanilla runtime names directly."
    };
  }
  return {
    ...buildSuggestedCall({
      tool: "resolve-artifact",
      params: buildResolveArtifactParams(
        { kind, value },
        { mapping: "obfuscated", ...(scope ? { scope } : {}) }
      )
    }),
    nextAction: "Retry with mapping=obfuscated to use the runtime obfuscated namespace."
  };
}

export async function resolveArtifact(svc: SourceService, input: ResolveArtifactInput): Promise<ResolveArtifactOutput> {
  let workspaceProvenance: WorkspaceResolutionProvenance | undefined;
  let dependencyProvenance: DependencyResolutionProvenance | undefined;
  let dependencyOrigin = false;
  let dependencyRequestedMapping: SourceMapping | undefined;
  const synthesisWarnings: string[] = [];

  if (input.target.kind === "workspace") {
    const synthesized = await svc.synthesizeWorkspaceTarget(input, input.target);
    workspaceProvenance = synthesized.provenance;
    synthesisWarnings.push(...synthesized.warnings);
    input = {
      ...input,
      target: synthesized.target,
      scope: synthesized.scope ?? input.scope,
      mapping: synthesized.mapping
    };
  } else if (input.target.kind === "dependency") {
    const synthesized = await svc.synthesizeDependencyTarget(input, input.target);
    dependencyProvenance = synthesized.provenance;
    dependencyOrigin = true;
    dependencyRequestedMapping = synthesized.requestedMapping;
    synthesisWarnings.push(...synthesized.warnings);
    input = { ...input, target: synthesized.target };
  }

  const target = input.target as SourceTargetInput;
  const kind = target.kind;
  let value = target.value?.trim();
  const mapping = normalizeMapping(input.mapping);
  const scope = input.scope;
  const warnings: string[] = [...synthesisWarnings];

  if (input.preferProjectVersion && input.projectPath && kind === "version") {
    const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(input.projectPath);
    if (detected && detected !== value) {
      warnings.push(`Overriding version "${value}" with project version "${detected}" from gradle.properties.`);
    }
    value = detected ?? value;
  }
  if (!value) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "target.value must be non-empty.",
      details: { target: input.target }
    });
  }
  if (kind !== "jar" && kind !== "coordinate" && kind !== "version") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported target kind "${kind}".`,
      details: { target: input.target }
    });
  }
  if (kind === "jar" && !value.toLowerCase().endsWith(".jar")) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "target.kind=jar requires a .jar path.",
      details: { target: input.target }
    });
  }

  const startedAt = Date.now();
  try {
    let resolvedTarget: SourceTargetInput = { kind, value };
    let resolvedVersion: string | undefined;
    let versionSourceDiscovery: VersionSourceDiscovery | undefined;
    if (kind === "version") {
      const versionJar = await svc.versionService.resolveVersionJar(value);
      resolvedVersion = versionJar.version;
      resolvedTarget = {
        kind: "jar",
        value: versionJar.jarPath
      };
      warnings.push(`Resolved Minecraft ${versionJar.version} from ${versionJar.clientJarUrl}.`);
    }
    let coordinateGroupId: string | undefined;
    if (kind === "coordinate") {
      try {
        const parsed = parseCoordinate(value);
        resolvedVersion = parsed.version;
        coordinateGroupId = parsed.groupId;
      } catch {
        // coordinate validity is validated by resolver
      }
    }

    // `isUnobfuscatedVersion` answers "does this MINECRAFT version ship unobfuscated
    // names in its runtime jar?", so it may only be asked about a string that really is
    // a Minecraft version. A kind="version" target always carries one. A coordinate
    // carries one only when it names the Minecraft runtime artifact itself
    // (net.minecraft:client:26.1); for any other coordinate the version segment is a
    // third-party library's own release number. Without this gate a dependency such as
    // org.jetbrains:annotations:26.0.2 parses as an "unobfuscated Minecraft version"
    // and short-circuits applyMappingPipeline into reporting mappingApplied="mojang"
    // with no remap performed, no verification, and no dependency-mapping-unverified
    // warning. A kind="dependency" target is excluded outright regardless of its group,
    // because binary remap is force-disabled for it (see forceBinaryRemapDisabled
    // below), so its mapping is never actually enforced either way.
    const versionNamesMinecraft =
      kind === "version" ||
      (kind === "coordinate" && !dependencyOrigin && coordinateGroupId === MINECRAFT_ARTIFACT_GROUP_ID);
    const minecraftVersion = versionNamesMinecraft ? resolvedVersion : undefined;
    const runtimeNamesUnobfuscated =
      minecraftVersion !== undefined && isUnobfuscatedVersion(minecraftVersion);

    let effectiveMapping: SourceMapping = mapping;
    if ((mapping === "intermediary" || mapping === "yarn") && runtimeNamesUnobfuscated) {
      warnings.push(
        `Version ${minecraftVersion} is unobfuscated; ${mapping} mappings are not applicable. Using the obfuscated namespace label for the deobfuscated runtime names.`
      );
      effectiveMapping = "obfuscated";
    }

    if (
      kind === "version" &&
      resolvedVersion &&
      effectiveMapping === "mojang" &&
      !runtimeNamesUnobfuscated &&
      scope !== "vanilla"
    ) {
      versionSourceDiscovery = await svc.discoverVersionSourceJar({
        version: resolvedVersion,
        projectPath: input.projectPath,
        gradleUserHome: input.gradleUserHome
      });
      if (versionSourceDiscovery.selectedSourceJarPath) {
        resolvedTarget = {
          kind: "jar",
          value: versionSourceDiscovery.selectedSourceJarPath
        };
        warnings.push(
          `Resolved source-backed artifact from Loom cache candidate: ${versionSourceDiscovery.selectedSourceJarPath}.`
        );
      }
    }

    const sourceJarPreSelected = Boolean(versionSourceDiscovery?.selectedSourceJarPath);
    const binaryRemapGate = sourceJarPreSelected
      ? { allowBinaryRemap: false, mappingVariant: "pass" as MappingVariant, warnings: [] }
      : await computeBinaryRemapGate(svc, {
          requestedMapping: effectiveMapping,
          runtimeNamesUnobfuscated,
          version: resolvedVersion,
          targetKind: kind,
          sourcePriority: input.sourcePriority,
          gradleUserHome: input.gradleUserHome,
          forceBinaryRemapDisabled: dependencyOrigin
        });
    if (binaryRemapGate.warnings.length > 0) {
      warnings.push(...binaryRemapGate.warnings);
    }

    const resolved = await resolveSourceTargetInternal(
      resolvedTarget,
      {
        allowDecompile: effectiveMapping === "mojang" ? true : input.allowDecompile ?? true,
        mappingVariant: binaryRemapGate.mappingVariant,
        onRepoFailover: (event: {
          stage: string;
          repoUrl: string;
          statusCode?: number;
          reason: string;
          attempt: number;
          totalAttempts: number;
        }) => {
          svc.metrics.recordRepoFailover();
          log("warn", "repo.failover", {
            stage: event.stage,
            repoUrl: event.repoUrl,
            statusCode: event.statusCode,
            reason: event.reason,
            attempt: event.attempt,
            totalAttempts: event.totalAttempts
          });
        }
      },
      svc.config
    );
    resolved.version = resolvedVersion;

    let mappingDecision: ReturnType<typeof applyMappingPipeline>;
    try {
      mappingDecision = applyMappingPipeline({
        requestedMapping: effectiveMapping,
        target: { kind, value },
        resolved,
        runtimeNamesUnobfuscated,
        allowBinaryRemap: binaryRemapGate.allowBinaryRemap
      });
    } catch (caughtError) {
      if (
        dependencyOrigin &&
        isAppError(caughtError) &&
        caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED
      ) {
        mappingDecision = {
          mappingApplied: "obfuscated",
          transformChain: [],
          qualityFlags: [
            ...(resolved.qualityFlags ?? []),
            "dependency-mapping-unverified"
          ]
        };
      } else if (isAppError(caughtError) && caughtError.code === ERROR_CODES.MAPPING_NOT_APPLIED) {
        const fallback = await svc.buildMappingFallbackSuggestedCall({
          input,
          kind,
          value,
          scope,
          effectiveMapping
        });
        const { nextAction, ...fallbackGated } = fallback;
        throw createError({
          code: ERROR_CODES.MAPPING_NOT_APPLIED,
          message: caughtError.message,
          details: {
            ...(caughtError.details ?? {}),
            artifactOrigin: resolved.origin,
            searchedPaths: versionSourceDiscovery?.searchedPaths ?? [],
            candidateArtifacts:
              versionSourceDiscovery?.candidateArtifacts ?? resolved.adjacentSourceCandidates ?? [],
            recommendedCommand: buildVersionSourceRecoveryCommand(input.projectPath),
            nextAction,
            ...fallbackGated
          }
        });
      } else {
        throw caughtError;
      }
    }
    const additionalTransformChain: string[] = [];
    if (!dependencyOrigin && (effectiveMapping === "intermediary" || effectiveMapping === "yarn")) {
      if (!resolved.version) {
        throw createError({
          code: ERROR_CODES.MAPPING_NOT_APPLIED,
          message: `Requested ${effectiveMapping} mapping cannot be guaranteed because artifact version is unknown.`,
          details: {
            mapping: effectiveMapping,
            target: { kind, value },
            nextAction:
              "Use target: { kind: \"version\", value } or a versioned Maven coordinate so mapping artifacts can be resolved.",
            ...buildSuggestedCall({
              tool: "resolve-artifact",
              params: buildResolveArtifactParams(
                { kind: "version", value },
                { ...(scope ? { scope } : {}) }
              )
            })
          }
        });
      }

      const mappingAvailability = await svc.mappingService.ensureMappingAvailable({
        version: resolved.version,
        sourceMapping: "obfuscated",
        targetMapping: effectiveMapping,
        sourcePriority: input.sourcePriority,
        gradleUserHome: input.gradleUserHome
      });
      additionalTransformChain.push(...mappingAvailability.transformChain);
      if (mappingAvailability.warnings.length > 0) {
        warnings.push(...mappingAvailability.warnings);
      }
    }
    const provenance = buildProvenance({
      requestedTarget: { kind, value },
      resolved,
      transformChain: [...mappingDecision.transformChain, ...additionalTransformChain]
    });
    if (workspaceProvenance) {
      provenance.workspaceResolution = workspaceProvenance;
    }
    if (dependencyProvenance) {
      provenance.dependencyResolution = dependencyProvenance;
    }
    if (
      versionSourceDiscovery?.companionSourceJarPaths?.length &&
      resolved.sourceJarPath === versionSourceDiscovery.selectedSourceJarPath
    ) {
      provenance.companionSourceJars = versionSourceDiscovery.companionSourceJarPaths;
    }

    if (
      dependencyOrigin &&
      dependencyRequestedMapping &&
      dependencyRequestedMapping !== "obfuscated" &&
      mappingDecision.qualityFlags.includes("dependency-mapping-unverified")
    ) {
      const coord = resolved.coordinate ?? value;
      warnings.push(
        `Dependency artifact ${coord} mapping "${dependencyRequestedMapping}" is not enforced (binary remap is disabled for non-vanilla artifacts); the JAR is returned in its native namespace and mappingApplied is reported as "obfuscated" with qualityFlag "dependency-mapping-unverified". Caller must validate symbol availability.`
      );
    }

    const provenanceWarnings = [...synthesisWarnings];
    if (provenanceWarnings.length > 0) {
      provenance.warnings = [...(provenance.warnings ?? []), ...provenanceWarnings];
    }

    resolved.requestedMapping = effectiveMapping;
    resolved.mappingApplied = mappingDecision.mappingApplied;
    resolved.provenance = provenance;
    resolved.qualityFlags = [...mappingDecision.qualityFlags];
    if (versionSourceDiscovery?.candidateArtifacts.length) {
      resolved.qualityFlags.push("source-jar-found");
    }
    if (versionSourceDiscovery?.selectedSourceJarPath) {
      resolved.qualityFlags.push("source-jar-validated");
      if (versionSourceDiscovery.selectedHasMinecraftNamespace === false) {
        resolved.qualityFlags.push("partial-source-no-net-minecraft");
        warnings.push(
          `Source coverage does not include net.minecraft for ${versionSourceDiscovery.selectedSourceJarPath}; class lookups may fall back to the binary artifact.`
        );
      }
      if (kind === "version" && !hasExactVersionToken(versionSourceDiscovery.selectedSourceJarPath, value)) {
        if (input.strictVersion) {
          throw createError({
            code: ERROR_CODES.VERSION_NOT_FOUND,
            message: `Strict version match failed: requested "${value}" but nearest source jar is for a different version.`,
            details: {
              requestedVersion: value,
              selectedSourceJar: versionSourceDiscovery.selectedSourceJarPath,
              candidateArtifacts: versionSourceDiscovery.candidateArtifacts,
              nextAction: "Use strictVersion=false (default) to allow approximation, or ensure the exact version source jar is in the Loom cache.",
              ...buildSuggestedCall({
                tool: "resolve-artifact",
                params: buildResolveArtifactParams({ kind: "version", value }, { strictVersion: false })
              })
            }
          });
        }
        resolved.qualityFlags.push("version-approximated");
        // Provenance must name the version that was SERVED. Echoing the request
        // here made a fallback indistinguishable from an exact hit, and left
        // downstream version context pointing at a version the jar is not.
        const servedVersion = inferRuntimeJarMinecraftVersion(
          versionSourceDiscovery.selectedSourceJarPath
        );
        provenance.versionApproximation = {
          requestedVersion: value,
          ...(servedVersion ? { servedVersion } : {}),
          sourceJarPath: versionSourceDiscovery.selectedSourceJarPath
        };
        if (servedVersion) {
          provenance.resolvedFrom.version = servedVersion;
        }
        warnings.push(
          `Requested version "${value}" but resolved source jar does not contain exact version string: ${versionSourceDiscovery.selectedSourceJarPath}` +
            (servedVersion ? ` (serving Minecraft ${servedVersion})` : "")
        );
      }
    }
    resolved.qualityFlags = dedupeQualityFlags(resolved.qualityFlags);
    const aliasValue =
      kind === "jar"
        ? (resolved.sourceJarPath ?? resolved.binaryJarPath ?? value)
        : value;
    const artifactAlias = buildArtifactAlias({
      artifactId: resolved.artifactId,
      kind,
      value: aliasValue,
      mappingVariant: binaryRemapGate.mappingVariant,
      resolvedVersion: resolvedVersion ?? resolved.version,
      coordinate: resolved.coordinate
    });
    resolved.artifactAlias = artifactAlias;
    await svc.ingestIfNeeded(resolved);

    let sampleEntries: string[] | undefined;
    if (input.includeSampleEntries && resolved.sourceJarPath) {
      try {
        const javaEntries = await listJavaEntries(resolved.sourceJarPath);
        const MAX_SAMPLE = 10;
        sampleEntries = javaEntries.slice(0, MAX_SAMPLE);
        if (javaEntries.length > MAX_SAMPLE) {
          sampleEntries.push(`... and ${javaEntries.length - MAX_SAMPLE} more .java entries`);
        }
      } catch {
        // non-fatal
      }
    }

    return {
      artifactId: resolved.artifactId,
      artifactAlias,
      origin: resolved.origin,
      isDecompiled: resolved.isDecompiled,
      resolvedSourceJarPath: resolved.sourceJarPath,
      adjacentSourceCandidates: resolved.adjacentSourceCandidates,
      binaryJarPath: resolved.binaryJarPath,
      coordinate: resolved.coordinate,
      version: resolved.version,
      requestedMapping: effectiveMapping,
      mappingApplied: mappingDecision.mappingApplied,
      provenance,
      qualityFlags: resolved.qualityFlags,
      repoUrl: resolved.repoUrl,
      artifactContents: svc.buildArtifactContentsSummary({
        origin: resolved.origin,
        sourceJarPath: resolved.sourceJarPath,
        isDecompiled: resolved.isDecompiled,
        qualityFlags: resolved.qualityFlags
      }),
      warnings,
      sampleEntries
    };
  } catch (caughtError) {
    if (isAppError(caughtError)) {
      throw caughtError;
    }
    throw createError({
      code: ERROR_CODES.ARTIFACT_RESOLUTION_FAILED,
      message: "Failed to resolve artifact.",
      details: {
        target: input.target,
        mapping,
        reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
      }
    });
  } finally {
    svc.metrics.recordDuration("resolve_duration_ms", Date.now() - startedAt);
  }
}
