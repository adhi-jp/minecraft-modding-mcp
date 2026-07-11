import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError } from "../errors.js";
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
import { isSafeMavenVersionToken } from "../workspace-mapping-service.js";
import type { WorkspaceContext } from "../workspace-context-cache.js";
import type { ResolveArtifactInput } from "../source-service.js";
import { normalizeMapping } from "./shared-utils.js";

// Env toggles are read at call time, not at module load: tests dynamically
// re-import source-service.ts with a cache-busting query to flip the flag,
// but cannot bust this module's cache through that path.

export async function loadOrDetectWorkspaceContext(svc: SourceService, projectPath: string): Promise<WorkspaceContext> {
  const cached = svc.workspaceContextCache.read(projectPath);
  if (cached && !cached.partial) {
    return cached;
  }

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
  const ctx: WorkspaceContext = {
    projectPath,
    minecraftVersion,
    compileMapping: mappingResult?.resolved ? mappingResult.mappingApplied : undefined,
    loader: loaderResult?.resolved ? loaderResult.loader : undefined,
    detectedAt: Date.now(),
    evidence,
    dependencyVersions: latest?.dependencyVersions ?? cached?.dependencyVersions ?? new Map<string, string>(),
    partial: false
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

  const projectPath = input.projectPath?.trim();
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
          params: {
            target: { kind: "version", value: "<your-mc-version>" },
            projectPath
          }
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
  if (
    group.includes("/") ||
    group.includes("\\") ||
    group.includes("..") ||
    group.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'target.kind="dependency" group/name must not contain path traversal characters.',
      details: {
        fieldErrors: [{ path: "target", message: "group and name must not contain '/', '\\', '..', or NUL." }]
      }
    });
  }

  if (dep.version) {
    if (!isSafeMavenVersionToken(dep.version)) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'target.kind="dependency" version must be a safe Maven coordinate segment.',
        details: {
          fieldErrors: [
            {
              path: "target.version",
              message:
                "version must contain only [A-Za-z0-9._+-] characters, must not start with '.', and must not include '..'."
            }
          ]
        }
      });
    }
    const coordinate = `${group}:${name}:${dep.version}`;
    return {
      target: { kind: "coordinate", value: coordinate },
      requestedMapping: input.mapping ? normalizeMapping(input.mapping) : undefined,
      warnings: [],
      provenance: {
        group,
        name,
        resolvedVersion: dep.version,
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

  const projectPath = input.projectPath?.trim();
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
  const warningsBucket: string[] = [];
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
    warnings: warningsBucket,
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
