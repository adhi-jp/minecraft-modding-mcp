import { statSync } from "node:fs";

import { stableArtifactId } from "./config.js";
import { normalizeJarPath } from "./path-resolver.js";
import { digestFile } from "./repo-downloader.js";
import type { MappingVariant } from "./types.js";

/**
 * The single owner of artifact identity: what an artifactId is derived from,
 * and how the derived signature is composed into the id.
 *
 * Five call sites produce a jar id - three in `src/source-resolver.ts` and two
 * in `src/source/artifact-resolver.ts` - and every one of them reaches it
 * through {@link jarArtifactIdentity}, so the derivation is written once. The
 * coordinate cascade's five results are composed by {@link composeArtifactId},
 * which is the only place either id layout appears.
 *
 * Both id spaces derive the same way: a sha256 of the bytes of the file the id
 * is about, produced by {@link contentSignature}. Neither composer takes a bare
 * `signature: string`, and the one signature type there is can only be built
 * from a value tagged as a content digest, so nothing cheaper can reach the
 * hash by a route nobody reviewed.
 */

/** A sha256 of the bytes of the file itself. */
export interface ContentDigestSignature {
  readonly from: "content-digest";
  readonly value: string;
}

export function contentDigestSignature(value: string): ContentDigestSignature {
  return { from: "content-digest", value };
}

/**
 * An id for a jar named by its path.
 *
 * The layout is `jar | <path> | <signature> | source`, plus `mojang-remapped`
 * when that variant applies. The trailing `source` is a constant part of the
 * layout with no producer that varies it; it is written out because the digest
 * depends on every part.
 */
export interface JarArtifactIdSpec {
  readonly space: "jar";
  /** Symlink-resolved, so two names for one file cannot mint two ids. */
  readonly jarPath: string;
  /**
   * A sha256 of the jar's bytes, the same kind of signature the coordinate
   * space takes. Required rather than merely permitted: a producer cannot
   * identify a jar by something cheaper without changing this type.
   */
  readonly signature: ContentDigestSignature;
  /**
   * Appended to the signature after a `:` before hashing. The decompile route
   * is the only user: the same jar read for its sources and the same jar handed
   * to the decompiler are different artifacts and must not share an id.
   */
  readonly signatureQualifier?: string;
  readonly mappingVariant?: MappingVariant;
}

/**
 * An id for an artifact reached through a Maven coordinate.
 *
 * The layout is `coord | <coordinate> | <idSource> | <signature>`, plus
 * `mojang-remapped` when that variant applies.
 *
 * The signature is a content digest of the bytes this cascade resolved, the
 * same as the jar space's.
 */
export interface CoordinateArtifactIdSpec {
  readonly space: "coordinate";
  readonly coordinate: string;
  /**
   * The id space this resolution belongs to, so artifacts discovered along
   * different paths cannot collide in the hash.
   */
  readonly idSource: string;
  readonly signature: ContentDigestSignature;
  readonly mappingVariant?: MappingVariant;
}

export type ArtifactIdSpec = JarArtifactIdSpec | CoordinateArtifactIdSpec;

/**
 * The qualifier the decompile route puts on a jar's signature. Shared so the
 * full resolve and the lightweight probe cannot spell it differently and mint
 * two ids for one decompiled jar.
 */
export const DECOMPILE_SIGNATURE_QUALIFIER = "decompile";

function qualifySignature(value: string, qualifier: string | undefined): string {
  return qualifier === undefined ? value : `${value}:${qualifier}`;
}

/** Compose an artifactId. The only place either id layout is written down. */
export function composeArtifactId(spec: ArtifactIdSpec): string {
  const parts =
    spec.space === "jar"
      // "jar" and "coord" are the tokens that enter the hash. They are not the
      // `space` discriminant values, which only pick the layout.
      ? ["jar", spec.jarPath, qualifySignature(spec.signature.value, spec.signatureQualifier), "source"]
      : ["coord", spec.coordinate, spec.idSource, spec.signature.value];
  if ((spec.mappingVariant ?? "pass") === "mojang-remapped") {
    parts.push("mojang-remapped");
  }
  return stableArtifactId(parts);
}

export interface JarArtifactIdentity {
  /** The symlink-resolved path the signature was read from and the id composed from. */
  readonly resolvedPath: string;
  /** The signature as published in `ResolvedSourceArtifact.artifactSignature`, qualifier included. */
  readonly signature: string;
  readonly artifactId: string;
}

export interface JarArtifactIdentityOptions {
  readonly signatureQualifier?: string;
  readonly mappingVariant?: MappingVariant;
}

/**
 * Normalize, derive, compose - in that order, for every jar-route producer.
 *
 * Normalizing first is what makes one jar under two names one artifact: the
 * path that enters the hash is the resolved one, never the one handed in.
 * `tests/source-service/probe-resolve-id-agreement.test.ts` pins that the
 * lightweight probe and a full resolve agree through a symlinked directory.
 *
 * The derivation is {@link contentSignature}, so a jar named by path is
 * identified by what is inside it: moving its mtime without changing a byte
 * leaves the id where it was, and replacing its bytes moves the id.
 *
 * Hashing reads the whole file, so every producer calls this on its own branch,
 * on the one file that branch's id is about, rather than once before the branch
 * is picked. The branch that adopts a sibling `-sources.jar` therefore hashes
 * that sibling and not the binary beside it, and the branch that finds no
 * sources and cannot decompile hashes nothing at all.
 */
export async function jarArtifactIdentity(
  jarPath: string,
  options: JarArtifactIdentityOptions = {}
): Promise<JarArtifactIdentity> {
  const resolvedPath = normalizeJarPath(jarPath);
  const signature = await contentSignature(resolvedPath);
  return {
    resolvedPath,
    signature: qualifySignature(signature.value, options.signatureQualifier),
    artifactId: composeArtifactId({
      space: "jar",
      jarPath: resolvedPath,
      signature,
      signatureQualifier: options.signatureQualifier,
      mappingVariant: options.mappingVariant
    })
  };
}

interface ContentSignatureEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly sha256: string;
}

/**
 * Digests already derived from a local jar, each pinned to the stat that
 * produced it.
 *
 * Keyed by the symlink-resolved path, so a jar reached through two names is
 * hashed once. The entry is only ever *reused*, never trusted on its own: it is
 * discarded unless size, mtimeMs, inode and ctimeMs all still match the file on
 * disk. ctimeMs is in that key because it is the field a write moves that
 * `utimes` cannot put back, so a same-size replacement carrying a restored
 * mtime is re-hashed rather than served the digest of the bytes it replaced.
 *
 * Known limitation: that guarantee is only as strong as the platform's
 * inode-change timestamp. Where a filesystem does not advance ctimeMs on a
 * write, this key degrades to size + mtime + inode and a same-size replacement
 * whose mtime was restored is served the recorded digest until the entry is
 * evicted. Nothing here re-reads the bytes to check.
 *
 * Bounded, like the helper caches in `src/source/artifact-resolver.ts`: this map
 * is module-level and lives as long as the process, and a long-running server
 * walks the resolution cascade once per target-driven tool call, so an
 * unbounded map grows with every distinct jar path the server has ever seen.
 * Eviction costs at most one re-hash, which is exactly what a cache miss
 * already costs.
 */
const contentSignatureCache = new Map<string, ContentSignatureEntry>();
const MAX_CONTENT_SIGNATURE_CACHE = 512;

/** Insert, dropping the oldest key first when the bound is reached. */
function rememberContentSignature(resolvedPath: string, entry: ContentSignatureEntry): void {
  if (!contentSignatureCache.has(resolvedPath) && contentSignatureCache.size >= MAX_CONTENT_SIGNATURE_CACHE) {
    const oldestKey = contentSignatureCache.keys().next().value as string | undefined;
    if (oldestKey) {
      contentSignatureCache.delete(oldestKey);
    }
  }
  contentSignatureCache.set(resolvedPath, entry);
}

/**
 * The identity of a jar sitting on local disk: a sha256 of its bytes.
 *
 * This is the derivation behind every artifactId this module composes - the
 * coordinate cascade's local legs call it directly, and the jar route reaches
 * it through {@link jarArtifactIdentity}.
 *
 * `~/.m2` and the Gradle module cache move a file's mtime for reasons that have
 * nothing to do with its contents - an eviction followed by a re-fetch of
 * byte-identical bytes, a filesystem restore, a plain `touch`. An `mtimeMs:size`
 * signature turns every one of those into a fresh artifactId and a fresh
 * decompile, which is exactly the instability the download cache's
 * content-addressed identity removed from the remote half of the coordinate
 * cascade.
 *
 * Hashing is not free and that cascade is re-walked on every target-driven tool
 * call, so the digest is memoized against the stat that produced it. The stat is
 * taken *before* the digest on purpose: bytes replaced mid-hash are recorded
 * against a stat they no longer have, so the entry is rejected on the next call
 * and re-derived - a wasted hash, never a wrong identity.
 */
export async function contentSignature(jarPath: string): Promise<ContentDigestSignature> {
  // The same normalization the jar route applies, kept so this path still
  // refuses a vanished or non-jar file the way it always has.
  const resolvedPath = normalizeJarPath(jarPath);
  const stats = statSync(resolvedPath);
  const cached = contentSignatureCache.get(resolvedPath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.ino === stats.ino &&
    cached.ctimeMs === stats.ctimeMs
  ) {
    return contentDigestSignature(cached.sha256);
  }

  const { contentSha256 } = await digestFile(resolvedPath);
  rememberContentSignature(resolvedPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ino: stats.ino,
    ctimeMs: stats.ctimeMs,
    sha256: contentSha256
  });
  return contentDigestSignature(contentSha256);
}
