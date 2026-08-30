import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES, isAppError } from "./errors.js";
import type {
  Config,
  MappingVariant,
  ResolvedSourceArtifact,
  SourceTargetInput
} from "./types.js";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  groupToPath,
  hasExistingJar,
  isMutableMavenCoordinate,
  parseCoordinate,
  normalizedCoordinateValue,
  type MavenCoordinate
} from "./maven-resolver.js";
import {
  defaultDownloadPath,
  digestFile,
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

/**
 * Digests already derived from a local jar, each pinned to the stat that
 * produced it.
 *
 * Keyed by the symlink-resolved path, so a jar reached through two names is
 * hashed once. The entry is only ever *reused*, never trusted on its own: a
 * mismatched mtime or size discards it, so the map cannot serve a digest for
 * bytes that have since been replaced.
 */
const contentSignatureCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

/**
 * The identity of a jar sitting on local disk: a sha256 of its bytes.
 *
 * `~/.m2` and the Gradle module cache move a file's mtime for reasons that have
 * nothing to do with its contents - an eviction followed by a re-fetch of
 * byte-identical bytes, a filesystem restore, a plain `touch`. An `mtimeMs:size`
 * signature turns every one of those into a fresh artifactId and a fresh
 * decompile, which is exactly the instability the download cache's
 * content-addressed identity removed from the remote half of this cascade.
 *
 * Hashing is not free and this cascade is re-walked on every target-driven tool
 * call, so the digest is memoized against the stat that produced it. The stat is
 * taken *before* the digest on purpose: bytes replaced mid-hash are recorded
 * against a stat they no longer have, so the entry is rejected on the next call
 * and re-derived - a wasted hash, never a wrong identity.
 */
async function contentSignature(jarPath: string): Promise<string> {
  // The same normalization `artifactSignatureFromFile` applied, kept so this
  // path still refuses a vanished or non-jar file the way it always has.
  const resolvedPath = normalizeJarPath(jarPath);
  const stats = statSync(resolvedPath);
  const cached = contentSignatureCache.get(resolvedPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.sha256;
  }

  const { contentSha256 } = await digestFile(resolvedPath);
  contentSignatureCache.set(resolvedPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    sha256: contentSha256
  });
  return contentSha256;
}

/**
 * Whether a jar contains java sources, with archive errors deliberately
 * propagating.
 *
 * This is the check for a jar that IS the subject of the request - the
 * `input.kind === "jar"` branch of `resolveSourceTarget` calling it on
 * `resolvedJarPath`. What propagates is the reader's refusal to OPEN the
 * archive: a truncated file, a non-zip file, an unreadable central directory,
 * an I/O failure. On the subject jar that refusal is the verdict itself, and
 * swallowing it would downgrade "this archive could not be read" into "this
 * archive has no sources" - handing back a sibling `-sources.jar` as if the
 * request had been satisfied.
 *
 * Note what this is NOT: `hasAnyJarEntry` does not reject an archive over a
 * traversal-named entry, it `continue`s past that entry and keeps scanning. A
 * zip-slip name inside an otherwise readable jar is skipped, not fatal, so it
 * is not among the errors this propagates.
 *
 * A jar the cascade merely *considered* is the opposite case: see
 * `candidateHasJavaSources`.
 */
async function hasJavaSources(jarPath: string): Promise<boolean> {
  if (!hasExistingJar(jarPath)) {
    return false;
  }
  return await hasAnyJarEntry(jarPath, hasJavaSourceExtension);
}

/**
 * The same check for a CANDIDATE, where an unopenable archive answers "no"
 * instead of throwing.
 *
 * The distinction is who the jar is. A candidate is one guess among several,
 * and the cascade behind it - the Gradle cache, the remote repositories, the
 * local-binary decompile branch - is exactly the repair path for a bad guess.
 * Letting the throw escape means one truncated `-sources.jar` in `~/.m2`
 * aborts `resolveSourceTarget` outright, and the caller is told the artifact
 * could not be resolved while it sits one candidate away. Mirrors
 * `isReadableJarArchive`, which already draws this line on the binary side.
 *
 * The catch is deliberately blanket, and it is worth naming what that covers
 * beyond invalid zip data: EACCES on a jar the process may not read, EMFILE
 * when descriptors run out, and a programming error in the reader itself - a
 * TypeError, a bad assertion - all become `false` here. That breadth is the
 * right call for this position, because every one of them means the same thing
 * to the cascade: this guess is unusable, take the next one. A candidate is a
 * guess, and narrowing the catch would turn a transient EMFILE into a failed
 * resolve for an artifact that is sitting in the Gradle cache.
 *
 * The accepted risk, stated plainly: a genuine bug in the jar reader would
 * surface as "no sources found" rather than as itself, and the cascade would
 * quietly fall through to a remote fetch or a decompile instead of reporting
 * it. That is bounded here in a way it is not elsewhere - the cost is one
 * skipped candidate per call, not repeated work or a poisoned cache entry -
 * which is why the download path's guard was narrowed and this one was not.
 * The subject-jar check above is the counterweight: a reader bug on the jar the
 * caller actually named still propagates.
 */
async function candidateHasJavaSources(jarPath: string): Promise<boolean> {
  try {
    return await hasJavaSources(jarPath);
  } catch {
    return false;
  }
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

/**
 * Refuses a path that is not strictly under `root`, and returns it otherwise.
 *
 * `resolvePath` is happy to walk out of the directory it was given - an
 * absolute-looking component discards the root, and `..` climbs out of it - so
 * "the root plus a caller-derived component" is a containment claim only once
 * something checks it. This is that check, and it fails closed: the caller gets
 * an error rather than a path outside the repository it named.
 *
 * The prefix comparison uses `${root}${sep}` rather than `root`, so a sibling
 * directory whose name merely starts with the root's (`/m2-evil` against
 * `/m2`) is not mistaken for a child.
 */
function assertUnderRoot(root: string, candidate: string, component: string): string {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Refusing a local repository path outside "${root}".`,
      details: { root, candidate, component }
    });
  }
  return candidate;
}

/**
 * Every `~/.m2` path a coordinate could name, before any of them is checked
 * against the filesystem.
 *
 * One builder for both the sources and the binary leg, and it takes an
 * already-parsed coordinate rather than the string: the two legs must never
 * disagree about where a coordinate lives, and `groupToPath` - not a naive
 * `replace(/\./g, "/")` - is what keeps the directory under `localM2Path` for a
 * groupId like `.`, `..` or `.a`, whose naive conversion is an absolute path
 * that `resolvePath` would honour.
 *
 * `MavenCoordinate` is a structural type with no runtime brand, so being an
 * exported deep-import surface, this function cannot assume its argument came
 * from `parseCoordinate`: a hand-built `artifactId`, `version` or `classifier`
 * carrying `../`, or a slash-bearing groupId, would otherwise escape through
 * `resolvePath` exactly as a validated one would not. Every path it returns is
 * therefore checked against `localM2Path` before it leaves - safe by
 * construction, not by the discipline of its callers. Production callers all
 * parse first and never trip this; the check is what makes that a belt rather
 * than the only strap.
 */
export function localM2CoordinateCandidatePaths(
  localM2Path: string,
  parsed: MavenCoordinate
): {
  sourceJarPaths: string[];
  exactBinaryJarPath: string;
  fallbackBinaryJarPaths: string[];
} {
  const root = resolvePath(localM2Path);
  const baseDir = assertUnderRoot(
    root,
    resolvePath(root, groupToPath(parsed.groupId), parsed.artifactId, parsed.version),
    "baseDir"
  );
  const base = `${parsed.artifactId}-${parsed.version}`;
  const classifierSuffix = parsed.classifier ? `-${parsed.classifier}` : "";
  const under = (fileName: string, component: string): string =>
    assertUnderRoot(root, resolvePath(baseDir, fileName), component);

  return {
    sourceJarPaths: [
      under(`${base}${classifierSuffix}-sources.jar`, "sourceJar"),
      under(`${base}-sources.jar`, "sourceJarFallback")
    ],
    exactBinaryJarPath: under(`${base}${classifierSuffix}.jar`, "binaryJar"),
    fallbackBinaryJarPaths: classifierSuffix ? [under(`${base}.jar`, "binaryJarFallback")] : []
  };
}

function resolveLocalCoordinateCandidates(localM2Path: string, coordinate: string): string[] {
  const { sourceJarPaths } = localM2CoordinateCandidatePaths(
    localM2Path,
    parseCoordinate(coordinate)
  );

  const existing = new Set<string>();
  for (const candidate of sourceJarPaths) {
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
  const { exactBinaryJarPath, fallbackBinaryJarPaths } = localM2CoordinateCandidatePaths(
    localM2Path,
    parseCoordinate(coordinate)
  );

  const exact = hasExistingJar(exactBinaryJarPath) ? exactBinaryJarPath : undefined;
  const companion = exact ?? fallbackBinaryJarPaths.find((candidate) => hasExistingJar(candidate));

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

/**
 * Why one remote repository attempt was abandoned, kept so the terminal error
 * can say something more useful than "unstable".
 *
 * The failover CALLBACK fires only when another repository is left to try, so
 * on the last one the reason was discarded outright - and the terminal
 * ERR_REPO_FETCH_FAILED then blamed "unstable repository responses" for
 * failures that were nothing of the sort. A download refused by the size
 * ceiling is the case that made this untenable: every repository trips it
 * identically, the user is told their repositories are unstable, and
 * `MCP_MAX_DOWNLOAD_BYTES` - the one thing that would fix it - is never
 * mentioned anywhere in the response.
 */
interface RepoAttemptFailure {
  stage: "source" | "binary";
  repoUrl: string;
  statusCode?: number;
  reason: string;
  /**
   * The failing error's own code, when it carried one (e.g. ERR_LIMIT_EXCEEDED).
   * Republished on the terminal error as the top-level `repoFailureCode`, which
   * is what actually reaches a caller - see `terminalDetails`.
   */
  code?: string;
  /**
   * The failing error's own recovery hint, lifted to the terminal error's
   * top-level `details.nextAction` where `toHints` will actually surface it.
   */
  nextAction?: string;
}

/**
 * Read an error thrown out of the download layer into a failover record.
 * `AppError` details are the only structured source available here; anything
 * else contributes its message alone.
 */
function describeThrownRepoFailure(
  stage: "source" | "binary",
  repoUrl: string,
  caughtError: unknown
): RepoAttemptFailure {
  const failure: RepoAttemptFailure = {
    stage,
    repoUrl,
    reason: caughtError instanceof Error ? caughtError.message : "download-error"
  };
  if (isAppError(caughtError)) {
    failure.code = caughtError.code;
    const nextAction = caughtError.details?.nextAction;
    if (typeof nextAction === "string" && nextAction.trim()) {
      failure.nextAction = nextAction.trim();
    }
  }
  return failure;
}

export async function resolveSourceTarget(
  input: SourceTargetInput,
  options: ResolveSourceTargetOptions,
  explicitConfig: Config
): Promise<ResolvedSourceArtifact> {
  const repos = options.preferredRepos?.length ? options.preferredRepos : explicitConfig.sourceRepos;
  let sawRemoteRepoFailure = false;
  let keptRepoFailure: RepoAttemptFailure | undefined;

  /**
   * Record one repository attempt's failure, keeping the one the caller can act
   * on.
   *
   * RULE: the FIRST failure carrying a `nextAction` wins and is never
   * overwritten; with none, the MOST RECENT failure is kept.
   *
   * Plain recency was wrong. A `nextAction` marks a configuration-driven
   * refusal - the download size ceiling is the case in hand - which names the
   * setting that fixes it. Every ordinary repository outcome (a 404, a 503, a
   * body that is not an archive) carries none, so under recency a single later
   * 404 on the binary leg erased the one failure with a repair in it and the
   * terminal error went back to saying only "unstable". FIRST rather than last
   * among the actionable ones because the earliest is the failure that was
   * still on the artifact the caller actually asked for: the source leg here
   * runs before the binary one, and the later stages are already consequences
   * of the first refusal. Actionable failures do not compete in practice - one
   * misconfigured ceiling trips every repository identically - so the tie-break
   * only decides which of several identical hints is quoted.
   */
  const recordRepoFailure = (failure: RepoAttemptFailure): void => {
    if (keptRepoFailure?.nextAction) {
      return;
    }
    keptRepoFailure = failure;
  };

  /**
   * Details for a terminal resolution error, carrying the kept repository
   * failure when there was one.
   *
   * Two fields are hoisted OUT of `lastRepoFailure` and onto the top level,
   * because that object is internal: `ProblemDetails` has no `details`
   * passthrough, and the public envelope serialises only selected fields, so
   * anything nested here never leaves the process.
   *  - `nextAction` is the one channel from a throw site to a caller's `hints`
   *    (`toHints` reads this key and nothing else).
   *  - `repoFailureCode` names the underlying cause as a primitive, so it can
   *    pass the primitive-only `context` allowlist and give a machine-readable
   *    counterpart to the human-readable hint.
   * `lastRepoFailure` itself stays for server-side logs and tests.
   */
  const terminalDetails = (coordinateValue: string): Record<string, unknown> => {
    if (!keptRepoFailure) {
      return { coordinate: coordinateValue };
    }
    const { nextAction, ...failure } = keptRepoFailure;
    return {
      coordinate: coordinateValue,
      lastRepoFailure: failure,
      ...(failure.code ? { repoFailureCode: failure.code } : {}),
      ...(nextAction ? { nextAction } : {})
    };
  };

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

    if (!preferBinaryOnly && await candidateHasJavaSources(exactSourceJarPath)) {
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
    if (await candidateHasJavaSources(candidate)) {
      const signature = await contentSignature(candidate);
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
  if (
    gradleCacheCandidate?.sourceJarPath &&
    (await candidateHasJavaSources(gradleCacheCandidate.sourceJarPath))
  ) {
    const signature = await contentSignature(gradleCacheCandidate.sourceJarPath);
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
  //
  // Existence alone is not proof: an interrupted local copy would otherwise get
  // to veto a perfectly good companion in the other cache, exactly the failure
  // `firstReadableJarArchive` exists to prevent elsewhere in this cascade. Kept
  // as a candidate list rather than resolved here, so the readable one is only
  // picked - lazily, at the one site that attaches it - once a remote sources
  // jar has actually been found and this is known to be needed.
  const localBinaryJarCandidates = [
    ...new Set(
      [localM2BinaryJarPath, gradleCacheCandidate?.binaryJarPath].filter(
        (candidate): candidate is string => candidate !== undefined
      )
    )
  ];

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
        //
        // Named by digest, because the archive check above just opened this
        // file and read its central directory, and the download cache is
        // shared: a concurrent resolve that finished a real jar into the same
        // slot meanwhile owns those bytes, and this verdict does not apply to
        // them.
        if (download.ok) {
          discardCachedDownload(download.path, {
            url: sourceUrl,
            contentSha256: download.contentSha256
          });
        }
        sourceJarHasJavaSources = false;
      }

      if (!download.ok || !sourceJarHasJavaSources) {
        // Transience only decides the error CODE at the end of the cascade: an
        // unstable repository earns ERR_REPO_FETCH_FAILED, while "this
        // repository does not publish it" stays a plain not-found.
        const transient = !download.ok && isTransientFailure(download.statusCode);
        sawRemoteRepoFailure = sawRemoteRepoFailure || transient;
        recordRepoFailure({
          stage: "source",
          repoUrl: sourceUrl,
          statusCode: download.statusCode,
          reason: download.ok ? "downloaded-no-sources" : "download-failed"
        });
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
        binaryJarPath: await firstReadableJarArchive(localBinaryJarCandidates),
        repoUrl: sourceUrl,
        isDecompiled: false
      });
    } catch (caughtError) {
      sawRemoteRepoFailure = true;
      const failure = describeThrownRepoFailure("source", sourceUrl, caughtError);
      recordRepoFailure(failure);
      if (hasNextAttempt) {
        options.onRepoFailover?.({
          stage: "source",
          repoUrl: sourceUrl,
          reason: failure.reason,
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
      details: terminalDetails(coordinate)
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
    const signature = await contentSignature(localDecompilableBinaryJarPath);
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
        recordRepoFailure({
          stage: "binary",
          repoUrl: binaryUrl,
          statusCode: downloaded.statusCode,
          reason: "download-failed"
        });
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
        // same poison with no request made at all. Named by digest: the check
        // above opens the zip and reads its central directory, and the download
        // cache is shared, so a concurrent resolve can have finished a real jar
        // into this same slot while it ran - bytes this verdict says nothing
        // about.
        discardCachedDownload(downloaded.path, {
          url: binaryUrl,
          contentSha256: downloaded.contentSha256
        });
        recordRepoFailure({
          stage: "binary",
          repoUrl: binaryUrl,
          statusCode: downloaded.statusCode,
          reason: "downloaded-not-an-archive"
        });
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
      const failure = describeThrownRepoFailure("binary", binaryUrl, caughtError);
      recordRepoFailure(failure);
      if (hasNextAttempt) {
        options.onRepoFailover?.({
          stage: "binary",
          repoUrl: binaryUrl,
          reason: failure.reason,
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
    details: terminalDetails(coordinate)
  });
}
