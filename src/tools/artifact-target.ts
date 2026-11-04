import { createError, isAppError } from "../errors.js";
import { reportedResolveNamespace } from "../source/artifact-resolver.js";
import type { ResolveArtifactInput, ResolveArtifactOutput } from "../source-service.js";
import type {
  ArtifactProvenance,
  ArtifactRow,
  ArtifactScope,
  ResolveArtifactTargetInput,
  SourceMapping
} from "../types.js";
import type { TargetKind } from "./schemas.js";
import type { CatalogServices, CatalogWarning } from "./types.js";

/** A parsed `target` object (the shared target schema has already checked its fields). */
export type CatalogTarget = {
  kind: TargetKind;
  artifactId?: string;
  version?: string;
  jarPath?: string;
  coordinate?: string;
  projectPath?: string;
  group?: string;
  name?: string;
  dependencyVersion?: string;
  scope?: ArtifactScope;
};

/**
 * The `result.artifact` block of a target-taking tool. `artifactId` can be
 * reused as `target: { kind: "artifact", artifactId }`. When a call that names a
 * version is served another version, `version` is the served version (absent
 * when unknown), `requestedVersion` the requested one, and
 * `versionApproximated` is true. A call with an `artifact` target names no
 * version, so its block carries only the served `version`.
 */
export type ArtifactBlock = {
  artifactId: string;
  version?: string;
  mappingApplied?: SourceMapping;
  requestedVersion?: string;
  versionApproximated?: true;
};

export type ResolvedCatalogTarget = {
  artifactId: string;
  artifact: ArtifactBlock;
  /** The resolver output; absent for `kind: "artifact"`, which reads the stored artifact instead. */
  resolved?: ResolveArtifactOutput;
  warnings: Array<string | CatalogWarning>;
};

/** Resolution tuning a caller may pass on top of the target. */
export type ResolveTuning = Omit<ResolveArtifactInput, "target" | "projectPath" | "scope">;

/**
 * The resolver's own sentence for a served version that differs from the
 * request. A catalog reply states the same fact as a `version-mismatch`
 * warning, so this sentence is left out.
 */
const APPROXIMATION_SENTENCE = /^Requested version ".*" but resolved source jar does not contain exact version string: /;

/** The resolver request for a target of any kind except `artifact`. */
export function toResolveArtifactRequest(
  target: CatalogTarget
): Pick<ResolveArtifactInput, "target" | "projectPath" | "scope"> {
  const projectPath = target.projectPath !== undefined ? { projectPath: target.projectPath } : {};
  let serviceTarget: ResolveArtifactTargetInput;
  switch (target.kind) {
    case "version":
      return {
        target: { kind: "version", value: target.version! },
        ...projectPath,
        ...(target.scope !== undefined ? { scope: target.scope } : {})
      };
    case "jar":
      serviceTarget = { kind: "jar", value: target.jarPath! };
      break;
    case "coordinate":
      serviceTarget = { kind: "coordinate", value: target.coordinate! };
      break;
    case "workspace":
      serviceTarget = { kind: "workspace", ...(target.scope !== undefined ? { scope: target.scope } : {}) };
      break;
    case "dependency":
      // An explicit dependencyVersion wins; otherwise projectPath means "read
      // the version from the project".
      serviceTarget = {
        kind: "dependency",
        group: target.group!,
        name: target.name!,
        ...(target.dependencyVersion !== undefined
          ? { version: target.dependencyVersion }
          : { versionFromProject: true })
      };
      break;
    case "artifact":
      throw new Error("an artifact target reuses its artifactId and is not resolved");
  }
  return { target: serviceTarget, ...projectPath };
}

function versionMismatchWarning(input: {
  requestedVersion?: string;
  servedVersion?: string;
  sourceJarPath?: string;
}): CatalogWarning {
  const requested = input.requestedVersion !== undefined ? `Minecraft ${input.requestedVersion}` : "The requested version";
  const served = input.servedVersion !== undefined ? `Minecraft ${input.servedVersion}` : "another version";
  const from = input.sourceJarPath !== undefined ? ` from ${input.sourceJarPath}` : "";
  return {
    code: "version-mismatch",
    severity: "warning",
    message:
      `${requested} has no exact source jar; this reply serves ${served}${from}. ` +
      "Pass strictVersion: true to artifact-resolve to fail instead."
  };
}

/** What a resolver output's disclosure is built from. */
type ArtifactFacts = {
  artifactId: string;
  version?: string | undefined;
  /** The namespace as reported to callers. */
  mappingApplied?: SourceMapping | undefined;
  qualityFlags?: readonly string[] | undefined;
  provenance?: ArtifactProvenance | undefined;
  warnings?: readonly string[] | undefined;
};

/**
 * The `artifact` block and warnings for an artifact. A served version that
 * differs from the request is never reported as plain success: the block
 * carries `versionApproximated` and `requestedVersion`, and a
 * `version-mismatch` warning names the served version when it is known.
 */
function describeArtifact(facts: ArtifactFacts): {
  artifact: ArtifactBlock;
  warnings: Array<string | CatalogWarning>;
} {
  const mappingApplied = facts.mappingApplied !== undefined ? { mappingApplied: facts.mappingApplied } : {};
  const approximation = facts.provenance?.versionApproximation;
  const approximated = facts.qualityFlags?.includes("version-approximated") === true || approximation !== undefined;
  const serviceWarnings = facts.warnings ?? [];
  if (!approximated) {
    return {
      artifact: {
        artifactId: facts.artifactId,
        ...(facts.version !== undefined ? { version: facts.version } : {}),
        ...mappingApplied
      },
      warnings: [...serviceWarnings]
    };
  }
  const requestedTarget = facts.provenance?.target;
  const requestedVersion =
    approximation?.requestedVersion ?? (requestedTarget?.kind === "version" ? requestedTarget.value : undefined);
  const servedVersion = approximation?.servedVersion;
  return {
    artifact: {
      artifactId: facts.artifactId,
      ...(servedVersion !== undefined ? { version: servedVersion } : {}),
      ...mappingApplied,
      ...(requestedVersion !== undefined ? { requestedVersion } : {}),
      versionApproximated: true
    },
    warnings: [
      versionMismatchWarning({
        ...(requestedVersion !== undefined ? { requestedVersion } : {}),
        ...(servedVersion !== undefined ? { servedVersion } : {}),
        ...(approximation?.sourceJarPath !== undefined ? { sourceJarPath: approximation.sourceJarPath } : {})
      }),
      ...serviceWarnings.filter((warning) => !APPROXIMATION_SENTENCE.test(warning))
    ]
  };
}

/** The `artifact` block and warnings for a resolver output. */
export function describeResolvedArtifact(resolved: ResolveArtifactOutput): {
  artifact: ArtifactBlock;
  warnings: Array<string | CatalogWarning>;
} {
  return describeArtifact({
    artifactId: resolved.artifactId,
    version: resolved.version,
    mappingApplied: reportedResolveNamespace(resolved),
    qualityFlags: resolved.qualityFlags,
    provenance: resolved.provenance,
    warnings: resolved.warnings
  });
}

/**
 * The `artifact` block for a stored artifact reused by its artifactId. Several
 * requested versions can share one artifact, and the stored row keeps the
 * request context of whichever resolve stored it first, so the block states
 * only facts about the artifact: `version` is the version it serves (absent
 * when unknown), with no `requestedVersion`, `versionApproximated` or
 * `version-mismatch` warning. The call that names a version reports the
 * approximation.
 */
function describeStoredArtifact(row: ArtifactRow, mappingApplied: SourceMapping | undefined): ArtifactBlock {
  const provenance = row.provenance;
  const approximated = row.qualityFlags.includes("version-approximated") || provenance?.versionApproximation !== undefined;
  // A recorded approximation means the row's own version may be the request.
  // A stored provenance may lack `resolvedFrom`, so it is read optionally.
  const version = approximated
    ? provenance?.versionApproximation?.servedVersion
    : (provenance?.resolvedFrom?.version ?? row.version);
  return {
    artifactId: row.artifactId,
    ...(version !== undefined ? { version } : {}),
    ...(mappingApplied !== undefined ? { mappingApplied } : {})
  };
}

/**
 * Runs a resolver call for `target`, reporting the resolver's field errors
 * under the catalog's names: for a `dependency` target, the version the
 * resolver calls `target.version` is `target.dependencyVersion`.
 */
export async function withCatalogFieldPaths<T>(target: CatalogTarget, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (caughtError) {
    if (target.kind !== "dependency" || !isAppError(caughtError)) throw caughtError;
    const fieldErrors = caughtError.details?.fieldErrors;
    if (!Array.isArray(fieldErrors)) throw caughtError;
    let renamed = false;
    const mapped = fieldErrors.map((entry: unknown) => {
      if (entry !== null && typeof entry === "object" && (entry as { path?: unknown }).path === "target.version") {
        renamed = true;
        return { ...(entry as Record<string, unknown>), path: "target.dependencyVersion" };
      }
      return entry;
    });
    if (!renamed) throw caughtError;
    throw createError({
      code: caughtError.code,
      message: caughtError.message,
      details: { ...caughtError.details, fieldErrors: mapped }
    });
  }
}

/**
 * Resolves a target to an artifact. `kind: "artifact"` reads the stored
 * artifact without resolving again and describes only the artifact itself
 * (see `describeStoredArtifact`); every other kind goes through the resolver
 * with `tuning`.
 */
export async function resolveCatalogTarget(
  services: CatalogServices,
  target: CatalogTarget,
  tuning: ResolveTuning = {}
): Promise<ResolvedCatalogTarget> {
  if (target.kind === "artifact") {
    const row = services.getArtifact(target.artifactId!);
    const artifact = describeStoredArtifact(row, services.reportedArtifactNamespace(row));
    return { artifactId: row.artifactId, artifact, warnings: [] };
  }
  const resolved = await withCatalogFieldPaths(target, () =>
    services.resolveArtifact({ ...toResolveArtifactRequest(target), ...tuning })
  );
  const described = describeResolvedArtifact(resolved);
  return { artifactId: resolved.artifactId, artifact: described.artifact, resolved, warnings: described.warnings };
}

/** The block with `mappingApplied` taken from a later service output when resolution did not report one. */
export function withMappingApplied(artifact: ArtifactBlock, mappingApplied: SourceMapping | undefined): ArtifactBlock {
  return artifact.mappingApplied !== undefined || mappingApplied === undefined ? artifact : { ...artifact, mappingApplied };
}
