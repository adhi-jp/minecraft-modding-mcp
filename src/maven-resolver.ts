import { accessSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, createError } from "./errors.js";
import {
  describeSafeMavenSegmentRule,
  isSafeMavenSegment,
  type MavenSegmentComponent
} from "./maven-token.js";

export interface MavenCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
  classifier?: string;
}

export interface MavenCandidate {
  coordinate: MavenCoordinate;
  sourceJarPath?: string;
  binaryJarPath?: string;
  sourceUrl?: string;
  binaryUrl?: string;
}

/**
 * Parses `group:artifact:version[:classifier]` - and is the single place a
 * caller-supplied coordinate is checked before any of it becomes a path.
 *
 * Every segment ends up as a directory or file-name component downstream (the
 * local `~/.m2` layout, the Gradle cache layout, and a remote repository URL),
 * so a segment carrying `/` or `..` would walk out of the repository root it
 * was resolved against. Validating here rather than at each sink means the nine
 * consumers of this function inherit the rule and cannot drift apart - which is
 * exactly how two different group-to-path builders came to exist.
 *
 * The rule is `isSafeMavenSegment`, the same one the `dependency` route now
 * applies to its `group`, `name` and `version` before it probes anything. That
 * route synthesises a coordinate and lands on these same sinks, so the two
 * cannot be allowed to answer differently. Its `..` clause rejects a groupId
 * like `a..b`; that input is contained under both builders and so is not a
 * safety matter, but a doubled dot yields an empty Maven path segment and is
 * not publishable, and rejecting it keeps the two routes answering identically.
 *
 * `version` and `classifier` additionally admit U+0020, because
 * `net.fabricmc:yarn:1.14 Pre-Release 1+build.10:v2` is a published coordinate
 * (see `SAFE_MAVEN_VALUE_RE`); `groupId` and `artifactId` do not.
 *
 * Each segment is trimmed before it is checked, so `"g : a : 1.0"` names the
 * artifact it obviously means instead of failing on the padding, and a leading
 * or trailing space cannot survive into a `version` either. `coordinate` in the
 * error details echoes the argument this function was handed - which is the
 * caller's own text only when the caller reached it directly; the public
 * artifact route trims `target.value` before calling, so outer padding on a
 * `target.kind="coordinate"` request is gone by the time it gets here.
 */
export function parseCoordinate(coordinate: string): MavenCoordinate {
  const values = coordinate.trim().split(":");
  if (values.length !== 3 && values.length !== 4) {
    throw createError({
      code: ERROR_CODES.COORDINATE_PARSE_FAILED,
      message: `Invalid maven coordinate "${coordinate}". Expected group:artifact:version[:classifier].`,
      details: { coordinate }
    });
  }

  const groupId = values[0]?.trim() ?? "";
  const artifactId = values[1]?.trim() ?? "";
  const version = values[2]?.trim() ?? "";
  const classifier = values[3]?.trim() || undefined;
  if (!groupId || !artifactId || !version) {
    // Names the empty segment too. Every other rejection below carries
    // `details.component`, and a caller branching on it should not have to
    // special-case the one branch that dropped it.
    const emptyComponent: MavenSegmentComponent = !groupId
      ? "groupId"
      : !artifactId
        ? "artifactId"
        : "version";
    throw createError({
      code: ERROR_CODES.COORDINATE_PARSE_FAILED,
      message: `Invalid maven coordinate "${coordinate}". All fields must be non-empty.`,
      details: { coordinate, component: emptyComponent }
    });
  }

  const segments: ReadonlyArray<readonly [MavenSegmentComponent, string]> = [
    ["groupId", groupId],
    ["artifactId", artifactId],
    ["version", version],
    // An absent classifier is not a segment; an empty or whitespace-only one
    // has already normalised to absent above.
    ...(classifier ? ([["classifier", classifier]] as const) : [])
  ];
  for (const [component, value] of segments) {
    if (!isSafeMavenSegment(value, component)) {
      throw createError({
        code: ERROR_CODES.COORDINATE_PARSE_FAILED,
        message: `Invalid maven coordinate "${coordinate}". ${describeSafeMavenSegmentRule(component)}`,
        details: { coordinate, component }
      });
    }
  }

  return {
    groupId,
    artifactId,
    version,
    classifier
  };
}

/**
 * Whether the artifacts behind a coordinate may change under a stable name.
 *
 * Maven defines exactly one mutable form: a version ending in `-SNAPSHOT`,
 * which a repository is free to republish for the same coordinate. A
 * timestamped unique snapshot (`1.0.0-20240101.120000-3`) is the resolved,
 * concrete build and never changes, so it is immutable - as is every release
 * version. Callers use this to pick a cache freshness policy: mutable
 * coordinates must be revalidated, immutable ones can be served from cache
 * forever.
 *
 * The suffix is matched case-insensitively, unlike Maven's own case-sensitive
 * `ArtifactUtils.isSnapshot`. The two error directions are not symmetric: being
 * stricter than a repository that publishes `-snapshot` would serve a mutable
 * artifact from cache forever, while being looser costs one conditional request
 * per resolve on a version that almost certainly meant `-SNAPSHOT` anyway.
 */
export function isMutableMavenCoordinate(coordinate: string): boolean {
  return /-SNAPSHOT$/i.test(parseCoordinate(coordinate).version);
}

/**
 * The one group-to-path conversion. Exported so no caller writes its own.
 *
 * `split(".").filter(Boolean).join("/")` is not the same as
 * `replace(/\./g, "/")`: dropping the empty segments means a groupId of `.`,
 * `..` or `.a` yields `""`, `""` and `"a"` rather than `"/"`, `"//"` and
 * `"/a"`. A leading slash is an absolute path, so under `path.resolve` the
 * naive form escapes the repository root entirely - no `/` and no `..` needed
 * in the input. This form cannot produce one, which makes the group leg safe by
 * construction rather than by whatever filter runs upstream of it.
 */
export function groupToPath(groupId: string): string {
  return groupId.split(".").filter(Boolean).join("/");
}

export function normalizedCoordinateValue(coordinate: string): string {
  const parsed = parseCoordinate(coordinate);
  return `${parsed.groupId}:${parsed.artifactId}:${parsed.version}${parsed.classifier ? `:${parsed.classifier}` : ""}`;
}

function localCandidatePaths(root: string, coordinate: MavenCoordinate): MavenCandidate {
  const groupPath = groupToPath(coordinate.groupId);
  const versionDir = join(root, groupPath, coordinate.artifactId, coordinate.version);
  const baseName = `${coordinate.artifactId}-${coordinate.version}`;

  const sourceFile = coordinate.classifier
    ? `${baseName}-${coordinate.classifier}-sources.jar`
    : `${baseName}-sources.jar`;
  const binaryFile = coordinate.classifier
    ? `${baseName}-${coordinate.classifier}.jar`
    : `${baseName}.jar`;

  return {
    coordinate,
    sourceJarPath: join(versionDir, sourceFile),
    binaryJarPath: join(versionDir, binaryFile)
  };
}

export function resolveLocalM2Candidate(localM2Path: string, coordinateValue: string): MavenCandidate {
  const parsed = parseCoordinate(coordinateValue);
  return localCandidatePaths(localM2Path, parsed);
}

export function localArtifactPathsFromCoordinate(localM2Path: string, coordinate: string): MavenCandidate {
  return resolveLocalM2Candidate(localM2Path, coordinate);
}

export function hasExistingJar(path: string | undefined): boolean {
  if (!path) {
    return false;
  }

  try {
    accessSync(path);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveLocalSourceJar(localM2Path: string, coordinate: string): string | undefined {
  const candidate = resolveLocalM2Candidate(localM2Path, coordinate);
  if (hasExistingJar(candidate.sourceJarPath)) {
    return candidate.sourceJarPath;
  }
  if (hasExistingJar(candidate.binaryJarPath)) {
    return undefined;
  }
  return undefined;
}

export function enumerateLocalAlternativeSourceJars(localM2Path: string, coordinate: string): string[] {
  const parsed = parseCoordinate(coordinate);
  const groupPath = groupToPath(parsed.groupId);
  const candidateDir = join(localM2Path, groupPath, parsed.artifactId, parsed.version);
  const exactSourcePrefix = `${parsed.artifactId}-${parsed.version}`;

  try {
    const files = readdirSync(candidateDir);
    const candidates = files
      .filter((fileName) => fileName.toLowerCase().endsWith("-sources.jar"))
      .filter((fileName) => fileName.startsWith(exactSourcePrefix))
      .map((fileName) => join(candidateDir, fileName));

    return candidates;
  } catch {
    return [];
  }
}

export function buildRemoteSourceUrls(
  repoBaseUrls: string[],
  coordinate: string
): string[] {
  const parsed = parseCoordinate(coordinate);
  const groupPath = groupToPath(parsed.groupId);
  const baseName = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";

  const sourceArtifact = `${baseName}${classifierSuffix}-sources.jar`;
  const fallbackSourceArtifact = `${baseName}-sources.jar`;

  const urls: string[] = [];
  for (const repo of repoBaseUrls) {
    const sourceUrl = `${repo.replace(/\/$/, "")}/${groupPath}/${parsed.artifactId}/${parsed.version}/${sourceArtifact}`;
    urls.push(sourceUrl);

    if (fallbackSourceArtifact !== sourceArtifact) {
      urls.push(`${repo.replace(/\/$/, "")}/${groupPath}/${parsed.artifactId}/${parsed.version}/${fallbackSourceArtifact}`);
    }
  }

  return urls;
}

export function buildRemoteBinaryUrls(repoBaseUrls: string[], coordinate: string): string[] {
  const parsed = parseCoordinate(coordinate);
  const groupPath = groupToPath(parsed.groupId);
  const baseName = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";
  const binaryArtifact = `${baseName}${classifierSuffix}.jar`;

  return repoBaseUrls.map(
    (repo) => `${repo.replace(/\/$/, "")}/${groupPath}/${parsed.artifactId}/${parsed.version}/${binaryArtifact}`
  );
}
