import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES } from "./errors.js";
import type {
  Config,
  MappingVariant,
  ResolvedSourceArtifact,
  SourceTargetInput
} from "./types.js";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  hasExistingJar,
  isMutableMavenCoordinate,
  parseCoordinate,
  normalizedCoordinateValue
} from "./maven-resolver.js";
import {
  defaultDownloadPath,
  discardCachedDownload,
  resolveCachedDownload,
  type CacheFreshness
} from "./repo-downloader.js";
import { artifactSignatureFromFile, normalizeJarPath } from "./path-resolver.js";
import { stableArtifactId } from "./config.js";
import { hasAnyJarEntry, hasJavaSourceExtension } from "./source-jar-reader.js";

function readStatsSignature(filePath: string): string {
  const stats = artifactSignatureFromFile(filePath);
  return stats.signature;
}

async function hasJavaSources(jarPath: string): Promise<boolean> {
  if (!hasExistingJar(jarPath)) {
    return false;
  }
  // Archive errors deliberately propagate. This runs on the jar-target path
  // (:336) where the jar IS the subject, and the reader's rejection of an
  // unsafe archive - a traversal-named entry, for one - is the fail-closed
  // refusal itself. Swallowing it here would downgrade "this archive is not
  // safe to open" into "this archive has no sources" and let resolution
  // continue past a jar it had already refused.
  return await hasAnyJarEntry(jarPath, hasJavaSourceExtension);
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

async function listAdjacentJarSourceCandidates(inputJarPath: string): Promise<string[]> {
  const directory = dirname(inputJarPath);
  const exact = resolveExactJarSourceCandidate(inputJarPath);
  const candidates = new Set<string>();
  try {
    for (const file of await readdir(directory)) {
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

interface LocalBinaryJarCandidates {
  /**
   * The jar whose file name spells out the coordinate in full, classifier
   * included. Only this one is the coordinate's own artifact, so only this one
   * may ever be returned as the resolved artifact.
   */
  exact?: string;
  /**
   * First jar on disk that can ride along as a companion `binaryJarPath` next
   * to a sources jar - the classifier-less jar included, because a classified
   * coordinate's sources are routinely published against the common binary.
   */
  companion?: string;
}

function resolveLocalCoordinateBinaryCandidates(
  localM2Path: string,
  coordinate: string
): LocalBinaryJarCandidates {
  const parsed = parseCoordinate(coordinate);
  const groupPath = parsed.groupId.replace(/\./g, "/");
  const baseDir = resolvePath(localM2Path, groupPath, parsed.artifactId, parsed.version);
  const base = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";

  const exactCandidate = resolvePath(baseDir, `${base}${classifierSuffix}.jar`);
  const fallbackCandidates = classifierSuffix ? [resolvePath(baseDir, `${base}.jar`)] : [];

  const exact = hasExistingJar(exactCandidate) ? exactCandidate : undefined;
  const companion = exact ?? fallbackCandidates.find((candidate) => hasExistingJar(candidate));

  return { exact, companion };
}

/**
 * Whether a jar on disk can actually be opened as an archive.
 *
 * `hasExistingJar` only proves that a file is present: an interrupted Gradle or
 * Maven copy leaves a 0-byte or truncated jar behind that passes that check and
 * then throws inside the decompiler on every call. Every sources branch of the
 * cascade already proves its candidate by opening the zip; a binary branch that
 * suppresses a remote download owes the caller the same proof.
 */
async function isReadableJarArchive(jarPath: string): Promise<boolean> {
  try {
    return await hasAnyJarEntry(jarPath, () => true);
  } catch {
    return false;
  }
}

/**
 * The first candidate that can actually be opened as an archive, in preference
 * order.
 *
 * Preference order is not the same as a pick: choosing the most-preferred
 * candidate and only then proving it lets one corrupt file veto every good one
 * behind it. Each candidate is proved before the next is considered, and the
 * archives are opened lazily, so the usual case still opens exactly one zip.
 */
async function firstReadableJarArchive(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isReadableJarArchive(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveGradleUserHome(): string {
  const configured = process.env.GRADLE_USER_HOME?.trim();
  if (configured) {
    return configured;
  }
  return resolvePath(homedir(), ".gradle");
}

async function resolveGradleCacheCoordinateCandidate(
  coordinate: string
): Promise<
  { sourceJarPath?: string; binaryJarPath?: string; exactBinaryJarPath?: string } | undefined
> {
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
  const exactBinaryName = `${base}${classifierSuffix}.jar`;
  const preferredBinaryNames = [exactBinaryName, ...(classifierSuffix ? [`${base}.jar`] : [])];

  let discoveredFiles: string[] = [];
  try {
    discoveredFiles = await fastGlob.glob("*/*", {
      cwd: baseDir,
      absolute: true,
      onlyFiles: true
    });
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

  return { sourceJarPath, binaryJarPath, exactBinaryJarPath: pickFirst([exactBinaryName]) };
}

function resolveRemoteBinaryCandidate(coordinate: string, repos: string[]): string[] {
  return buildRemoteBinaryUrls(repos, coordinate);
}

export type { MappingVariant } from "./types.js";

export function artifactIdForJar(
  inputKind: string,
  artifactPath: string,
  signature: string,
  suffix?: string,
  mappingVariant: MappingVariant = "pass"
): string {
  const parts = [inputKind, artifactPath, signature, suffix ?? "source"];
  if (mappingVariant === "mojang-remapped") {
    parts.push("mojang-remapped");
  }
  return stableArtifactId(parts);
}

function artifactIdForCoordinate(
  coordinate: string,
  source: string,
  signature: string,
  mappingVariant: MappingVariant = "pass"
): string {
  const parts = ["coord", coordinate, source, signature];
  if (mappingVariant === "mojang-remapped") {
    parts.push("mojang-remapped");
  }
  return stableArtifactId(parts);
}

function resolvedAtNow(): string {
  return new Date().toISOString();
}

interface CoordinateArtifactSpec {
  coordinate: string;
  /**
   * The id space this resolution belongs to. Independent of `origin`: it only
   * keeps artifacts discovered along different paths from colliding in the
   * artifact id hash.
   */
  idSource: string;
  signature: string;
  origin: ResolvedSourceArtifact["origin"];
  isDecompiled: boolean;
  sourceJarPath?: string;
  binaryJarPath?: string;
  repoUrl?: string;
  mappingVariant?: MappingVariant;
}

/** Shared shape for every artifact the coordinate cascade can return. */
function coordinateArtifact(spec: CoordinateArtifactSpec): ResolvedSourceArtifact {
  return {
    artifactId: artifactIdForCoordinate(
      spec.coordinate,
      spec.idSource,
      spec.signature,
      spec.mappingVariant ?? "pass"
    ),
    artifactSignature: spec.signature,
    origin: spec.origin,
    sourceJarPath: spec.sourceJarPath,
    binaryJarPath: spec.binaryJarPath,
    coordinate: spec.coordinate,
    repoUrl: spec.repoUrl,
    isDecompiled: spec.isDecompiled,
    resolvedAt: resolvedAtNow()
  };
}

export interface ResolveSourceTargetOptions {
  allowDecompile: boolean;
  preferBinaryOnly?: boolean;
  preferredRepos?: string[];
  /**
   * When set to "mojang-remapped", the artifactId hash gets a dedicated
   * suffix so the mojang-remapped variant of an otherwise binary-only artifact
   * occupies its own cache slot. Defaults to "pass" which preserves the
   * legacy hash for obfuscated and source-backed artifacts.
   */
  mappingVariant?: MappingVariant;
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
    const adjacentSourceCandidates = await listAdjacentJarSourceCandidates(resolvedJarPath);
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
      artifactId: artifactIdForJar(
        "jar",
        resolvedJarPath,
        `${binarySignature}:decompile`,
        undefined,
        options.mappingVariant ?? "pass"
      ),
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
  // Maven republishes -SNAPSHOT coordinates under the same name, so their cached
  // downloads have to be confirmed with the repository; every other version is
  // immutable and is served straight from the download cache. Decided once so
  // the sources leg and the binary leg cannot disagree.
  const downloadFreshness: CacheFreshness = isMutableMavenCoordinate(coordinate)
    ? "revalidate"
    : "immutable";
  const isTransientFailure = (statusCode?: number): boolean =>
    statusCode === undefined || statusCode >= 500 || statusCode === 429;

  const localM2Binary = resolveLocalCoordinateBinaryCandidates(explicitConfig.localM2Path, coordinate);
  const localM2BinaryJarPath = localM2Binary.companion;

  for (const candidate of resolveLocalCoordinateCandidates(explicitConfig.localM2Path, coordinate)) {
    if (await hasJavaSources(candidate)) {
      const signature = readStatsSignature(candidate);
      return coordinateArtifact({
        coordinate,
        idSource: "local-m2",
        signature,
        origin: "local-m2",
        sourceJarPath: candidate,
        binaryJarPath: localM2BinaryJarPath,
        isDecompiled: false
      });
    }
  }

  const gradleCacheCandidate = await resolveGradleCacheCoordinateCandidate(coordinate);
  if (gradleCacheCandidate?.sourceJarPath && (await hasJavaSources(gradleCacheCandidate.sourceJarPath))) {
    const signature = readStatsSignature(gradleCacheCandidate.sourceJarPath);
    return coordinateArtifact({
      coordinate,
      idSource: "local-m2",
      signature,
      origin: "local-m2",
      sourceJarPath: gradleCacheCandidate.sourceJarPath,
      binaryJarPath: gradleCacheCandidate.binaryJarPath,
      isDecompiled: false
    });
  }

  // Both local branches above are gated on SOURCES: a module that ships a binary jar
  // locally but publishes no sources jar falls through them, and the binary jar they
  // already discovered would be dropped even though it is still perfectly usable. Keep
  // it here so the artifact that is ultimately returned still carries a binaryJarPath
  // for binary-only consumers (get-class-members and friends).
  const localBinaryJarPath = localM2BinaryJarPath ?? gradleCacheCandidate?.binaryJarPath;

  // The companion above may be the classifier-less jar, which is a different
  // artifact than a classified coordinate asks for. That substitution is fine
  // for a jar that merely rides along beside a sources jar, and wrong for one
  // returned as the resolution itself, so the decompile branch below considers
  // only jars whose name spells the coordinate out in full.
  //
  // A list rather than a single pick: ~/.m2 is preferred over the Gradle cache,
  // but preferring it must not mean an interrupted copy sitting there gets to
  // veto a perfectly good jar behind it - forcing a needless download, or an
  // outright failure when offline.
  const localDecompilableBinaryCandidates = [
    ...new Set(
      [localM2Binary.exact, gradleCacheCandidate?.exactBinaryJarPath].filter(
        (candidate): candidate is string => candidate !== undefined
      )
    )
  ];

  const remoteSourceUrls = buildRemoteSourceUrls(repos, coordinate);
  for (let index = 0; index < remoteSourceUrls.length; index++) {
    const sourceUrl = remoteSourceUrls[index];
    const hasNextAttempt = index < remoteSourceUrls.length - 1;
    try {
      const sourceDestinationPath = defaultDownloadPath(explicitConfig.cacheDir, sourceUrl);
      const download = await resolveCachedDownload(sourceUrl, sourceDestinationPath, {
        freshness: downloadFreshness,
        retries: explicitConfig.fetchRetries,
        timeoutMs: explicitConfig.fetchTimeoutMs
      });

      let sourceJarHasJavaSources: boolean;
      try {
        sourceJarHasJavaSources = download.ok && (await hasJavaSources(download.path));
      } catch {
        // The download reports success, but the bytes are not a readable
        // archive - the same "200 but not really a jar" shape the binary leg
        // guards against below. Evict it now: this url is immutable for every
        // non-SNAPSHOT coordinate, so a future call would otherwise be served
        // the same poison with no request made at all.
        if (download.ok) {
          discardCachedDownload(download.path);
        }
        sourceJarHasJavaSources = false;
      }

      if (!download.ok || !sourceJarHasJavaSources) {
        // Transience only decides the error CODE at the end of the cascade: an
        // unstable repository earns ERR_REPO_FETCH_FAILED, while "this
        // repository does not publish it" stays a plain not-found.
        const transient = !download.ok && isTransientFailure(download.statusCode);
        sawRemoteRepoFailure = sawRemoteRepoFailure || transient;
        // Moving off this repository is reportable however it happened. A
        // withdrawn artifact reaches here as an ordinary failure now that the
        // downloader refuses to launder a 404 into a stale success, and leaving
        // that silent would hide the one event that explains why the resolved
        // artifact came from somewhere else.
        if (hasNextAttempt) {
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

      // Identity follows the bytes. The HTTP validators that used to form this
      // signature rotate whenever a CDN or repository migration happens, even
      // when the jar is byte-identical.
      const signature = download.contentSha256;
      return coordinateArtifact({
        coordinate,
        idSource: "remote-repo",
        signature,
        origin: "remote-repo",
        sourceJarPath: download.path,
        binaryJarPath: localBinaryJarPath,
        repoUrl: sourceUrl,
        isDecompiled: false
      });
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

  // A module that publishes no sources jar but whose binary jar is already on
  // local disk has nothing left to fetch: ingest decompiles the binary, and the
  // local copy is the same artifact the repository would hand back. Deliberately
  // placed after the allowDecompile guard - returning it earlier would perform
  // the decompile the caller just declined. The dedicated "local-binary" id space
  // keeps it apart from the remote "decompiled" one; no coordinate resolve has
  // ever returned a local binary jar, so nothing needs migrating.
  //
  // The jar has to be a readable archive before it may stand in for the download:
  // a truncated local copy would otherwise be handed to the decompiler on every
  // call with no way out. When none of the candidates is, the remote binary loop
  // below is exactly the repair path, so this falls through to it instead of
  // failing. The zips are opened here and only here - nothing upstream has looked
  // inside these jars, and control only reaches this point when the branch is
  // about to be taken.
  const localDecompilableBinaryJarPath = await firstReadableJarArchive(
    localDecompilableBinaryCandidates
  );
  if (localDecompilableBinaryJarPath) {
    const signature = readStatsSignature(localDecompilableBinaryJarPath);
    return coordinateArtifact({
      coordinate,
      idSource: "local-binary",
      signature,
      origin: "local-m2",
      binaryJarPath: localDecompilableBinaryJarPath,
      isDecompiled: true,
      mappingVariant: options.mappingVariant ?? "pass"
    });
  }

  const binaryCandidates = resolveRemoteBinaryCandidate(coordinate, repos);
  for (let index = 0; index < binaryCandidates.length; index++) {
    const binaryUrl = binaryCandidates[index];
    const hasNextAttempt = index < binaryCandidates.length - 1;
    try {
      const binaryDestinationPath = defaultDownloadPath(explicitConfig.cacheDir, binaryUrl);
      const downloaded = await resolveCachedDownload(binaryUrl, binaryDestinationPath, {
        freshness: downloadFreshness,
        retries: explicitConfig.fetchRetries,
        timeoutMs: explicitConfig.fetchTimeoutMs
      });

      if (!downloaded.ok) {
        const transient = isTransientFailure(downloaded.statusCode);
        sawRemoteRepoFailure = sawRemoteRepoFailure || transient;
        if (hasNextAttempt) {
          options.onRepoFailover?.({
            stage: "binary",
            repoUrl: binaryUrl,
            statusCode: downloaded.statusCode,
            reason: "download-failed",
            attempt: index + 1,
            totalAttempts: binaryCandidates.length
          });
        }
        continue;
      }

      // A 200 is not proof of a jar. A repository, a mirror, or a proxy in front
      // of one answers a jar request with an HTML error page often enough that
      // accepting any non-empty body writes it into the (immutable) download
      // cache, returns it as the artifact, and blocks failover to a repository
      // that has the real thing - with the failure surfacing much later, inside
      // the decompiler. The sources leg has always proved its download by opening
      // it; this one owes the caller the same proof.
      if (!(await isReadableJarArchive(downloaded.path))) {
        // And the body must not survive as a cache entry: this url is immutable
        // for every non-SNAPSHOT coordinate, so the next run would be served the
        // same poison with no request made at all.
        discardCachedDownload(downloaded.path);
        if (hasNextAttempt) {
          options.onRepoFailover?.({
            stage: "binary",
            repoUrl: binaryUrl,
            statusCode: downloaded.statusCode,
            reason: "downloaded-not-an-archive",
            attempt: index + 1,
            totalAttempts: binaryCandidates.length
          });
        }
        continue;
      }

      // A file in the URL-keyed download cache is identified by its bytes, not
      // by a stat signature that a re-download would change for free.
      const signature = downloaded.contentSha256;
      return coordinateArtifact({
        coordinate,
        idSource: "decompiled",
        signature,
        origin: "decompiled",
        binaryJarPath: downloaded.path,
        repoUrl: binaryUrl,
        isDecompiled: true,
        mappingVariant: options.mappingVariant ?? "pass"
      });
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
