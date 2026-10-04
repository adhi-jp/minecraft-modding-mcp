import { resolve as resolvePath } from "node:path";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError } from "../errors.js";
import { normalizeOptionalProjectPath } from "../gradle-paths.js";
import type { SourceService } from "../source-service.js";
import type {
  ArtifactScope,
  DependencyResolutionProvenance,
  DependencyTargetInput,
  SourceMapping,
  SourceTargetInput,
  WorkspaceResolutionProvenance,
  WorkspaceTargetInput
} from "../types.js";
import { describeSafeMavenSegmentRule, isSafeMavenSegment } from "../maven-token.js";
import { computeWorkspaceContextFingerprint } from "../workspace-context-cache.js";
import type { WorkspaceContext } from "../workspace-context-cache.js";
import type { ResolveArtifactInput } from "../source-service.js";
import { normalizeMapping } from "./shared-utils.js";

// Env toggles are read at call time, not at module load: tests dynamically
// re-import source-service.ts with a cache-busting query to flip the flag,
// but cannot bust this module's cache through that path.

/**
 * The root-level files `detectProjectMinecraftVersion`/`detectCompileMapping`/
 * `detectProjectLoader` (src/workspace-mapping-service.ts) are guaranteed to
 * read (or attempt to read) for every project, independent of what detection
 * finds: `gradle.properties` by exact path, and `build.gradle`/`build.gradle.kts`
 * by exact path as the first two entries of the build-script glob those two
 * methods both run before descending into subdirectories. `settings.gradle(.kts)`
 * and `libs.versions.toml` are not read by any of the three, so they are not
 * listed here - see the coverage note on `fingerprintPaths` below.
 */
function fixedDetectionFilenames(): readonly string[] {
  return ["gradle.properties", "build.gradle", "build.gradle.kts"];
}

export async function loadOrDetectWorkspaceContext(svc: SourceService, projectPath: string): Promise<WorkspaceContext> {
  const cached = svc.workspaceContextCache.read(projectPath);
  if (cached && !cached.partial) {
    return cached;
  }

  const projectRoot = resolvePath(projectPath);
  // Snapshotted BEFORE detection runs, not after: an edit that lands while
  // detection is mid-read (racing the very call below) must still show up as
  // a stat difference on the next read. Fingerprinting after detection would
  // record whatever is on disk at that later point - which could already be
  // the edit that should have invalidated the entry, silently absorbing the
  // race into a "the cache is fresh" fingerprint instead of catching it.
  const fixedFingerprint = computeWorkspaceContextFingerprint(
    fixedDetectionFilenames().map((filename) => resolvePath(projectRoot, filename))
  );

  const [minecraftVersion, mappingResult, loaderResult] = await Promise.all([
    svc.workspaceMappingService.detectProjectMinecraftVersion(projectPath),
    svc.workspaceMappingService.detectCompileMapping({ projectPath }).catch(() => undefined),
    svc.workspaceMappingService.detectProjectLoader(projectPath).catch(() => undefined)
  ]);

  const evidence: WorkspaceContext["evidence"] = [];
  if (minecraftVersion) {
    evidence.push({
      source: "gradle.properties",
      field: "minecraft_version",
      value: minecraftVersion
    });
  }
  if (mappingResult?.resolved && mappingResult.evidence[0]) {
    evidence.push({
      source: mappingResult.evidence[0].filePath,
      field: "compileMapping",
      value: mappingResult.mappingApplied
    });
  }
  if (loaderResult?.resolved && loaderResult.evidence[0]) {
    evidence.push({
      source: loaderResult.evidence[0].filePath,
      field: "loader",
      value: loaderResult.loader
    });
  }

  const latest = svc.workspaceContextCache.read(projectPath);
  // Fingerprint the files this detection actually read (or, for the fixed
  // root set above, attempted to read regardless of outcome), so a later
  // cache hit can catch an edit made within the TTL instead of serving a
  // stale minecraftVersion/mapping/loader for up to five more minutes.
  //
  // Coverage: `fixedFingerprint` above (taken pre-detection) covers
  // gradle.properties and a root-level build.gradle/build.gradle.kts,
  // present or not - editing, creating, or deleting any of those three
  // always invalidates. mapping/loader detection also globs subproject
  // build scripts (`**/build.gradle(.kts)`) and, for the loader, mod
  // descriptor files (`fabric.mod.json`, `quilt.mod.json`,
  // `META-INF/{mods,neoforge.mods}.toml`) anywhere under the project; only
  // the ones that actually produced a mapping/loader declaration are known
  // here (as `evidence[].filePath`) and fingerprinted below. A subproject
  // build script or descriptor that was scanned but declared nothing is NOT
  // covered - editing one to newly declare a mapping/loader is not caught
  // until the TTL expires, same as before this fingerprint existed.
  // settings.gradle(.kts) and libs.versions.toml are not read by detection
  // at all, so they are never fingerprinted.
  const fixedPaths = new Set(fixedFingerprint.map((entry) => entry.path));
  const evidencePaths = [
    ...(mappingResult?.evidence.map((entry) => entry.filePath) ?? []),
    ...(loaderResult?.evidence.map((entry) => entry.filePath) ?? [])
  ].filter((path) => !fixedPaths.has(resolvePath(path)));
  const fingerprint = [
    ...fixedFingerprint,
    // A path already covered by fixedFingerprint above (taken pre-detection)
    // is skipped here rather than re-stat-ed post-detection: keeping only
    // the earlier snapshot is what makes that entry catch a mid-detection
    // race at all, and a second, later entry for the same path would just
    // add a redundant stat on every read without changing the result.
    ...computeWorkspaceContextFingerprint(evidencePaths)
  ];
  const ctx: WorkspaceContext = {
    projectPath,
    minecraftVersion,
    compileMapping: mappingResult?.resolved ? mappingResult.mappingApplied : undefined,
    loader: loaderResult?.resolved ? loaderResult.loader : undefined,
    detectedAt: Date.now(),
    evidence,
    dependencyVersions: latest?.dependencyVersions ?? cached?.dependencyVersions ?? new Map<string, string>(),
    partial: false,
    fingerprint
  };
  svc.workspaceContextCache.write(ctx);
  return ctx;
}

export async function synthesizeWorkspaceTarget(
  svc: SourceService,
  input: ResolveArtifactInput,
  workspace: WorkspaceTargetInput
): Promise<{
  target: SourceTargetInput;
  scope?: ArtifactScope;
  mapping?: SourceMapping;
  provenance: WorkspaceResolutionProvenance;
  warnings: string[];
}> {
  if (process.env.WORKSPACE_TARGET_OFF === "1") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'target.kind="workspace" is disabled by WORKSPACE_TARGET_OFF=1.',
      details: {
        fieldErrors: [{ path: "target.kind", message: 'target.kind="workspace" is disabled.' }]
      }
    });
  }

  // Normalized once, here, and used for everything below: the workspace-context
  // cache key, the detection reads and the provenance all have to name the same
  // path. Trimming alone left a Windows-spelled path unreadable on a WSL host
  // for this target kind while the sibling routes resolved it.
  const projectPath = normalizeOptionalProjectPath(input.projectPath);
  if (!projectPath) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'projectPath is required when target.kind="workspace".',
      details: {
        fieldErrors: [{ path: "projectPath", message: 'projectPath is required when target.kind="workspace".' }]
      }
    });
  }

  const cachedBefore = svc.workspaceContextCache.read(projectPath);
  const cacheHit = Boolean(cachedBefore && !cachedBefore.partial);
  const ctx = cacheHit ? cachedBefore! : await svc.loadOrDetectWorkspaceContext(projectPath);

  const warnings: string[] = [];
  const resolvedVersion = ctx.minecraftVersion;
  if (!resolvedVersion) {
    throw createError({
      code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
      message: `Could not detect a Minecraft version for projectPath "${projectPath}".`,
      details: {
        projectPath,
        strict: workspace.strict === true,
        nextAction:
          "Set minecraft_version in gradle.properties or pass target.kind=\"version\" with an explicit Minecraft version.",
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: undefined,
          examples: [
            {
              params: {
                target: { kind: "version", value: "<your-mc-version>" },
                projectPath
              },
              reason: "Replace <your-mc-version> with the Minecraft version, or set minecraft_version in gradle.properties."
            }
          ]
        })
      }
    });
  }

  const requestedMapping = normalizeMapping(input.mapping);
  let effectiveMapping: SourceMapping | undefined;
  if (input.mapping) {
    effectiveMapping = requestedMapping;
    if (ctx.compileMapping && ctx.compileMapping !== requestedMapping) {
      warnings.push(
        `Compile mapping mismatch (workspace=${ctx.compileMapping}, requested=${requestedMapping}); using requested mapping.`
      );
    }
  } else {
    effectiveMapping = ctx.compileMapping ?? "obfuscated";
  }

  const effectiveScope: ArtifactScope = workspace.scope ?? input.scope ?? (ctx.loader ? "merged" : "vanilla");

  const provenance: WorkspaceResolutionProvenance = {
    projectPath,
    detected: {
      minecraftVersion: ctx.minecraftVersion,
      compileMapping: ctx.compileMapping,
      loader: ctx.loader
    },
    source: ctx.evidence
      .map((entry) => `${entry.source}:${entry.field}`)
      .join("; ") || (cacheHit ? "workspace-context-cache" : "workspace-detection"),
    cacheHit,
    warnings: [...warnings]
  };

  return {
    target: { kind: "version", value: resolvedVersion },
    scope: effectiveScope,
    mapping: effectiveMapping,
    provenance,
    warnings
  };
}

export async function synthesizeDependencyTarget(
  svc: SourceService,
  input: ResolveArtifactInput,
  dep: DependencyTargetInput
): Promise<{
  target: SourceTargetInput;
  provenance: DependencyResolutionProvenance;
  requestedMapping?: SourceMapping;
  warnings: string[];
}> {
  if (process.env.DEPENDENCY_TARGET_OFF === "1") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'target.kind="dependency" is disabled by DEPENDENCY_TARGET_OFF=1.',
      details: {
        fieldErrors: [{ path: "target.kind", message: 'target.kind="dependency" is disabled.' }]
      }
    });
  }

  const group = dep.group?.trim();
  const name = dep.name?.trim();
  if (!group || !name) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'target.kind="dependency" requires non-empty group and name.',
      details: {
        fieldErrors: [
          ...(group ? [] : [{ path: "target.group", message: "group is required" }]),
          ...(name ? [] : [{ path: "target.name", message: "name is required" }])
        ]
      }
    });
  }
  // The chokepoint for this route is HERE, not at the coordinate synthesised
  // further down, because a dependency without an explicit version reaches a
  // filesystem sink first: `detectDependencyVersion` builds
  // `<gradle-home>/caches/modules-2/files-2.1/<group>/<name>` and reads it, and
  // the entry names it finds come back to the caller in `candidatesSeen`. A
  // later coordinate rejection cannot undo a directory that has already been
  // listed.
  //
  // The character list this check used to carry - `/`, `\`, `..`, NUL - is not
  // enough for that sink. `group="D:"` with `name="."` contains none of them,
  // yet `path.resolve(gradleRoot, ..., "D:", ".")` is drive-relative on Windows
  // and lands outside the Gradle cache root entirely. The shared segment rule
  // is an allowlist, so it refuses `D:` for the colon and `.` for the leading
  // dot, and it does so on every platform - which matters here because this
  // project's CI never runs on the one platform where that path shape bites.
  const identifierSegments = [
    ["groupId", "target.group", "group", group],
    ["artifactId", "target.name", "name", name]
  ] as const;
  for (const [component, path, label, value] of identifierSegments) {
    if (!isSafeMavenSegment(value, component)) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" group and name must be safe Maven coordinate segments.',
        details: {
          fieldErrors: [{ path, message: describeSafeMavenSegmentRule(component, label) }]
        }
      });
    }
  }

  if (dep.version) {
    // Trimmed BEFORE it is validated, exactly as `parseCoordinate` trims each
    // segment before checking it. Validating first made `" 1.0 "` an error on
    // this route and a resolvable coordinate on the other one, for the same
    // artifact.
    const version = dep.version.trim();
    if (!isSafeMavenSegment(version, "version")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" version must be a safe Maven coordinate segment.',
        details: {
          fieldErrors: [
            {
              path: "target.version",
              message: describeSafeMavenSegmentRule("version")
            }
          ]
        }
      });
    }
    const coordinate = `${group}:${name}:${version}`;
    return {
      target: { kind: "coordinate", value: coordinate },
      requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
      warnings: [],
      provenance: {
        group,
        name,
        resolvedVersion: version,
        source: "explicit",
        cacheHit: false
      }
    };
  }

  if (dep.versionFromProject === false) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'target.kind="dependency" requires version when versionFromProject=false.',
      details: {
        fieldErrors: [
          { path: "target.version", message: "version is required when versionFromProject=false." }
        ]
      }
    });
  }

  const projectPath = normalizeOptionalProjectPath(input.projectPath);
  if (!projectPath) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'projectPath is required when target.kind="dependency" without an explicit version.',
      details: {
        fieldErrors: [{ path: "projectPath", message: 'projectPath is required for dependency target without version.' }]
      }
    });
  }

  const cacheKey = `${group}:${name}`;
  const ctxBefore = svc.workspaceContextCache.read(projectPath);
  const cachedVersion = ctxBefore?.dependencyVersions.get(cacheKey);
  if (cachedVersion) {
    const coordinate = `${group}:${name}:${cachedVersion}`;
    return {
      target: { kind: "coordinate", value: coordinate },
      requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
      warnings: [],
      provenance: {
        group,
        name,
        resolvedVersion: cachedVersion,
        source: "workspace-context-cache",
        cacheHit: true
      }
    };
  }

  const result = await svc.workspaceMappingService.detectDependencyVersion(projectPath, group, name);
  if (!result.resolved) {
    const ambiguous = result.candidatesSeen.length > 1;
    const message = ambiguous
      ? `Multiple cached versions for ${group}:${name} in ~/.gradle/caches/modules-2 (${result.candidatesSeen.join(", ")}); refusing to pick without project-specific evidence.`
      : `Could not resolve a version for dependency ${group}:${name} from gradle.properties or modules-2 cache.`;
    const nextAction = ambiguous
      ? `Set ${name}_version (or another supported gradle.properties key) so the project's intended version is unambiguous, pass an explicit version on the dependency target, or declare the umbrella version property so the cached umbrella POM can supply the submodule version.`
      : "Provide an explicit version on the dependency target, or add a property to gradle.properties so detectDependencyVersion can find it.";
    throw createError({
      code: ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED,
      message,
      details: {
        group,
        name,
        attempts: result.attempts,
        candidatesSeen: result.candidatesSeen,
        ambiguous,
        nextAction,
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: undefined,
          examples: [
            {
              params: {
                target: {
                  kind: "dependency",
                  group,
                  name,
                  version: "<your-version>"
                },
                projectPath
              },
              reason: "Replace <your-version> with the dependency version, or declare it in gradle.properties."
            }
          ]
        })
      }
    });
  }

  const ctxAfter = svc.workspaceContextCache.read(projectPath);
  if (ctxAfter) {
    const updatedDeps = new Map(ctxAfter.dependencyVersions);
    updatedDeps.set(cacheKey, result.version);
    svc.workspaceContextCache.write({ ...ctxAfter, dependencyVersions: updatedDeps });
  } else {
    const updatedDeps = new Map<string, string>();
    updatedDeps.set(cacheKey, result.version);
    svc.workspaceContextCache.write({
      projectPath,
      detectedAt: Date.now(),
      evidence: [],
      dependencyVersions: updatedDeps,
      partial: true
    });
  }

  const coordinate = `${group}:${name}:${result.version}`;
  return {
    target: { kind: "coordinate", value: coordinate },
    requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
    warnings: [],
    provenance: {
      group,
      name,
      resolvedVersion: result.version,
      source: result.source,
      candidatesSeen: result.candidatesSeen,
      attempts: result.attempts,
      cacheHit: false,
      ...(result.submoduleVersionSource
        ? { submoduleVersionSource: result.submoduleVersionSource }
        : {})
    }
  };
}
