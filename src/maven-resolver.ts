import { accessSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, createError } from "./errors.js";

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

export function parseCoordinate(coordinate: string): MavenCoordinate {
  const values = coordinate.trim().split(":");
  if (values.length !== 3 && values.length !== 4) {
    throw createError({
      code: ERROR_CODES.COORDINATE_PARSE_FAILED,
      message: `Invalid maven coordinate "${coordinate}". Expected group:artifact:version[:classifier].`,
      details: { coordinate }
    });
  }

  const [groupId, artifactId, version, classifier] = values;
  if (!groupId || !artifactId || !version) {
    throw createError({
      code: ERROR_CODES.COORDINATE_PARSE_FAILED,
      message: `Invalid maven coordinate "${coordinate}". All fields must be non-empty.`,
      details: { coordinate }
    });
  }

  return {
    groupId,
    artifactId,
    version,
    classifier: classifier?.trim() || undefined
  };
}

function groupToPath(groupId: string): string {
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
