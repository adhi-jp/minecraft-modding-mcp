import { readdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import { createError, ERROR_CODES } from "./errors.js";
import type { Config, ResolvedSourceArtifact, SourceTargetInput } from "./types.js";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  hasExistingJar,
  parseCoordinate,
  normalizedCoordinateValue
} from "./maven-resolver.js";
import { defaultDownloadPath, downloadToCache, type DownloadResult } from "./repo-downloader.js";
import { artifactSignatureFromFile, normalizeJarPath } from "./path-resolver.js";
import { stableArtifactId } from "./config.js";
import { listJavaEntries } from "./source-jar-reader.js";

function readStatsSignature(filePath: string): string {
  const stats = artifactSignatureFromFile(filePath);
  return stats.signature;
}

async function hasJavaSources(jarPath: string): Promise<boolean> {
  if (!hasExistingJar(jarPath)) {
    return false;
  }
  const entries = await listJavaEntries(jarPath);
  return entries.length > 0;
}

function resolveExactJarSourceCandidate(inputJarPath: string): string {
  const directory = dirname(inputJarPath);
  const jarName = basename(inputJarPath);
  const base = jarName.endsWith(".jar") ? jarName.slice(0, -4) : jarName;
  return join(directory, `${base}-sources.jar`);
}

function resolveSiblingBinaryJarCandidate(inputJarPath: string): string | undefined {
  const directory = dirname(inputJarPath);
  const jarName = basename(inputJarPath);
  if (!jarName.endsWith("-sources.jar")) {
    return undefined;
  }
  const binaryName = `${jarName.slice(0, -"-sources.jar".length)}.jar`;
  const candidate = join(directory, binaryName);
  return hasExistingJar(candidate) ? candidate : undefined;
}

function listAdjacentJarSourceCandidates(inputJarPath: string): string[] {
  const directory = dirname(inputJarPath);
  const exact = resolveExactJarSourceCandidate(inputJarPath);
  const candidates = new Set<string>();
  try {
    for (const file of readdirSync(directory)) {
      if (file.toLowerCase().endsWith("-sources.jar")) {
        const candidate = join(directory, file);
        if (candidate !== inputJarPath && candidate !== exact) {
          candidates.add(candidate);
        }
      }
    }
  } catch {
    // ignore
  }
  return [...candidates];
}

function resolveLocalCoordinateCandidates(localM2Path: string, coordinate: string): string[] {
  const parsed = parseCoordinate(coordinate);
  const groupPath = parsed.groupId.replace(/\./g, "/");
  const baseDir = resolvePath(localM2Path, groupPath, parsed.artifactId, parsed.version);
  const base = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";

  const direct = resolvePath(baseDir, `${base}${classifierSuffix}-sources.jar`);
  const fallback = resolvePath(baseDir, `${base}-sources.jar`);
  const candidates = [direct, fallback];

  const existing = new Set<string>();
  for (const candidate of candidates) {
    if (hasExistingJar(candidate)) {
      existing.add(candidate);
    }
  }

  return [...existing];
}

function resolveLocalCoordinateBinaryCandidate(localM2Path: string, coordinate: string): string | undefined {
  const parsed = parseCoordinate(coordinate);
  const groupPath = parsed.groupId.replace(/\./g, "/");
  const baseDir = resolvePath(localM2Path, groupPath, parsed.artifactId, parsed.version);
  const base = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";

  const candidates = [
    resolvePath(baseDir, `${base}${classifierSuffix}.jar`),
    ...(classifierSuffix ? [resolvePath(baseDir, `${base}.jar`)] : [])
  ];

  return candidates.find((candidate) => hasExistingJar(candidate));
}

function resolveGradleUserHome(): string {
  const configured = process.env.GRADLE_USER_HOME?.trim();
  if (configured) {
    return configured;
  }
  return resolvePath(homedir(), ".gradle");
}

function resolveGradleCacheCoordinateCandidate(
  coordinate: string
): { sourceJarPath?: string; binaryJarPath?: string } | undefined {
  const parsed = parseCoordinate(coordinate);
  const baseDir = resolvePath(
    resolveGradleUserHome(),
    "caches",
    "modules-2",
    "files-2.1",
    parsed.groupId,
    parsed.artifactId,
    parsed.version
  );
  const base = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";
  const preferredSourceNames = [
    `${base}${classifierSuffix}-sources.jar`,
    ...(classifierSuffix ? [`${base}-sources.jar`] : [])
  ];
  const preferredBinaryNames = [
    `${base}${classifierSuffix}.jar`,
    ...(classifierSuffix ? [`${base}.jar`] : [])
  ];

  let discoveredFiles: string[] = [];
  try {
    const hashes = readdirSync(baseDir);
    for (const hashDir of hashes) {
      const fullDir = join(baseDir, hashDir);
      for (const entry of readdirSync(fullDir)) {
        discoveredFiles.push(join(fullDir, entry));
      }
    }
  } catch {
    return undefined;
  }

  discoveredFiles = discoveredFiles.filter((entry) => hasExistingJar(entry)).sort((left, right) => left.localeCompare(right));
  const pickFirst = (candidates: string[]): string | undefined => {
    for (const fileName of candidates) {
      const match = discoveredFiles.find((entry) => basename(entry) === fileName);
      if (match) {
        return match;
      }
    }
    return undefined;
  };

  const sourceJarPath = pickFirst(preferredSourceNames);
  const binaryJarPath = pickFirst(preferredBinaryNames);
  if (!sourceJarPath && !binaryJarPath) {
    return undefined;
  }

  return { sourceJarPath, binaryJarPath };
}

function resolveRemoteBinaryCandidate(coordinate: string, repos: string[]): string[] {
  return buildRemoteBinaryUrls(repos, coordinate);
}

function artifactIdForJar(inputKind: string, artifactPath: string, signature: string, suffix?: string): string {
  return stableArtifactId([inputKind, artifactPath, signature, suffix ?? "source"]);
}

function artifactIdForCoordinate(
  coordinate: string,
  source: string,
  signature: string
): string {
  return stableArtifactId(["coord", coordinate, source, signature]);
}

function resolvedAtNow(): string {
  return new Date().toISOString();
}

export interface ResolveSourceTargetOptions {
  allowDecompile: boolean;
  preferBinaryOnly?: boolean;
  preferredRepos?: string[];
  onRepoFailover?: (event: {
    stage: "source" | "binary";
    repoUrl: string;
    statusCode?: number;
    reason: string;
    attempt: number;
    totalAttempts: number;
  }) => void;
}

export async function resolveSourceTarget(
  input: SourceTargetInput,
  options: ResolveSourceTargetOptions,
  explicitConfig: Config
): Promise<ResolvedSourceArtifact> {
  const repos = options.preferredRepos?.length ? options.preferredRepos : explicitConfig.sourceRepos;
  let sawRemoteRepoFailure = false;

  if (input.kind === "jar") {
    const resolvedJarPath = normalizeJarPath(input.value);
    const binarySignature = readStatsSignature(resolvedJarPath);
    const exactSourceJarPath = resolveExactJarSourceCandidate(resolvedJarPath);
    const adjacentSourceCandidates = listAdjacentJarSourceCandidates(resolvedJarPath);
    const maybeAdjacentSourceCandidates =
      adjacentSourceCandidates.length > 0 ? adjacentSourceCandidates : undefined;
    const preferBinaryOnly = options.preferBinaryOnly ?? false;

    if (await hasJavaSources(resolvedJarPath)) {
      const siblingBinaryJarPath = resolveSiblingBinaryJarCandidate(resolvedJarPath);
      const binaryJarPath =
        siblingBinaryJarPath ??
        (basename(resolvedJarPath).endsWith("-sources.jar") ? undefined : resolvedJarPath);
      return {
        artifactId: artifactIdForJar("jar", resolvedJarPath, binarySignature),
        artifactSignature: binarySignature,
        origin: "local-jar",
        binaryJarPath,
        sourceJarPath: resolvedJarPath,
        adjacentSourceCandidates: maybeAdjacentSourceCandidates,
        isDecompiled: false,
        resolvedAt: resolvedAtNow()
      };
    }

    if (!preferBinaryOnly && await hasJavaSources(exactSourceJarPath)) {
      const sourceSignature = readStatsSignature(exactSourceJarPath);
      return {
        artifactId: artifactIdForJar("jar", exactSourceJarPath, sourceSignature),
        artifactSignature: sourceSignature,
        origin: "local-jar",
        binaryJarPath: resolvedJarPath,
        sourceJarPath: exactSourceJarPath,
        adjacentSourceCandidates: maybeAdjacentSourceCandidates,
        isDecompiled: false,
        resolvedAt: resolvedAtNow()
      };
    }

    if (!options.allowDecompile) {
      throw createError({
        code: ERROR_CODES.SOURCE_NOT_FOUND,
        message: `No source jar was found for "${input.value}" and decompile is disabled.`,
        details: {
          jarPath: resolvedJarPath,
          adjacentSourceCandidates: maybeAdjacentSourceCandidates
        }
      });
    }

    return {
      artifactId: artifactIdForJar("jar", resolvedJarPath, `${binarySignature}:decompile`),
      artifactSignature: `${binarySignature}:decompile`,
      origin: "decompiled",
      binaryJarPath: resolvedJarPath,
      adjacentSourceCandidates: maybeAdjacentSourceCandidates,
      isDecompiled: true,
      resolvedAt: resolvedAtNow()
    };
  }

  if (input.kind !== "coordinate") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported input kind "${input.kind}".`,
      details: { input }
    });
  }

  const coordinate = normalizedCoordinateValue(input.value);
  const isTransientFailure = (statusCode?: number): boolean =>
    statusCode === undefined || statusCode >= 500 || statusCode === 429;

  for (const candidate of resolveLocalCoordinateCandidates(explicitConfig.localM2Path, coordinate)) {
    if (await hasJavaSources(candidate)) {
      const signature = readStatsSignature(candidate);
      return {
        artifactId: artifactIdForCoordinate(coordinate, "local-m2", signature),
        artifactSignature: signature,
        origin: "local-m2",
        sourceJarPath: candidate,
        binaryJarPath: resolveLocalCoordinateBinaryCandidate(explicitConfig.localM2Path, coordinate),
        coordinate,
        isDecompiled: false,
        resolvedAt: resolvedAtNow()
      };
    }
  }

  const gradleCacheCandidate = resolveGradleCacheCoordinateCandidate(coordinate);
  if (gradleCacheCandidate?.sourceJarPath && (await hasJavaSources(gradleCacheCandidate.sourceJarPath))) {
    const signature = readStatsSignature(gradleCacheCandidate.sourceJarPath);
    return {
      artifactId: artifactIdForCoordinate(coordinate, "local-m2", signature),
      artifactSignature: signature,
      origin: "local-m2",
      sourceJarPath: gradleCacheCandidate.sourceJarPath,
      binaryJarPath: gradleCacheCandidate.binaryJarPath,
      coordinate,
      isDecompiled: false,
      resolvedAt: resolvedAtNow()
    };
  }

  const remoteSourceUrls = buildRemoteSourceUrls(repos, coordinate);
  for (let index = 0; index < remoteSourceUrls.length; index++) {
    const sourceUrl = remoteSourceUrls[index];
    const hasNextAttempt = index < remoteSourceUrls.length - 1;
    try {
      const download = await downloadToCache(sourceUrl, defaultDownloadPath(explicitConfig.cacheDir, sourceUrl), {
        retries: explicitConfig.fetchRetries,
        timeoutMs: explicitConfig.fetchTimeoutMs
      });

      if (!download.ok || !download.path || !(await hasJavaSources(download.path))) {
        const transient = download.ok
          ? false
          : download.statusCode !== 404 && isTransientFailure(download.statusCode);
        sawRemoteRepoFailure = sawRemoteRepoFailure || transient;
        if (hasNextAttempt && transient) {
          options.onRepoFailover?.({
            stage: "source",
            repoUrl: sourceUrl,
            statusCode: download.statusCode,
            reason: download.ok ? "downloaded-no-sources" : "download-failed",
            attempt: index + 1,
            totalAttempts: remoteSourceUrls.length
          });
        }
        continue;
      }

      const signature = `${download.contentLength ?? 0}:${download.etag ?? ""}:${download.lastModified ?? ""}`;
      return {
        artifactId: artifactIdForCoordinate(coordinate, "remote-repo", signature),
        artifactSignature: signature,
        origin: "remote-repo",
        sourceJarPath: download.path,
        coordinate,
        repoUrl: sourceUrl,
        isDecompiled: false,
        resolvedAt: resolvedAtNow()
      };
    } catch (caughtError) {
      sawRemoteRepoFailure = true;
      if (hasNextAttempt) {
        options.onRepoFailover?.({
          stage: "source",
          repoUrl: sourceUrl,
          reason: caughtError instanceof Error ? caughtError.message : "download-error",
          attempt: index + 1,
          totalAttempts: remoteSourceUrls.length
        });
      }
    }
  }

  if (!options.allowDecompile) {
    throw createError({
      code: sawRemoteRepoFailure ? ERROR_CODES.REPO_FETCH_FAILED : ERROR_CODES.SOURCE_NOT_FOUND,
      message: sawRemoteRepoFailure
        ? `No source jar was found for "${coordinate}" and repository fetches were unstable.`
        : `No source jar was found for "${coordinate}" and decompile is disabled.`,
      details: { coordinate }
    });
  }

  const binaryCandidates = resolveRemoteBinaryCandidate(coordinate, repos);
  for (let index = 0; index < binaryCandidates.length; index++) {
    const binaryUrl = binaryCandidates[index];
    const hasNextAttempt = index < binaryCandidates.length - 1;
    try {
      const downloaded: DownloadResult = await downloadToCache(binaryUrl, defaultDownloadPath(explicitConfig.cacheDir, binaryUrl), {
        retries: explicitConfig.fetchRetries,
        timeoutMs: explicitConfig.fetchTimeoutMs
      });

      if (!downloaded.ok || !downloaded.path) {
        const transient = downloaded.ok
          ? false
          : downloaded.statusCode !== 404 && isTransientFailure(downloaded.statusCode);
        sawRemoteRepoFailure = sawRemoteRepoFailure || transient;
        if (hasNextAttempt && transient) {
          options.onRepoFailover?.({
            stage: "binary",
            repoUrl: binaryUrl,
            statusCode: downloaded.statusCode,
            reason: downloaded.ok ? "downloaded-no-binary" : "download-failed",
            attempt: index + 1,
            totalAttempts: binaryCandidates.length
          });
        }
        continue;
      }

      const signature = readStatsSignature(downloaded.path);
      return {
        artifactId: artifactIdForCoordinate(coordinate, "decompiled", signature),
        artifactSignature: signature,
        origin: "decompiled",
        binaryJarPath: downloaded.path,
        coordinate,
        repoUrl: binaryUrl,
        isDecompiled: true,
        resolvedAt: resolvedAtNow()
      };
    } catch (caughtError) {
      sawRemoteRepoFailure = true;
      if (hasNextAttempt) {
        options.onRepoFailover?.({
          stage: "binary",
          repoUrl: binaryUrl,
          reason: caughtError instanceof Error ? caughtError.message : "download-error",
          attempt: index + 1,
          totalAttempts: binaryCandidates.length
        });
      }
    }
  }

  throw createError({
    code: sawRemoteRepoFailure ? ERROR_CODES.REPO_FETCH_FAILED : ERROR_CODES.SOURCE_NOT_FOUND,
    message: sawRemoteRepoFailure
      ? `No source or binary artifact was found for "${coordinate}" due to unstable repository responses.`
      : `No source or binary artifact was found for "${coordinate}".`,
    details: { coordinate }
  });
}
