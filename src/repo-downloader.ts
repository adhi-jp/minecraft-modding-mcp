import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createError, ERROR_CODES } from "./errors.js";

/**
 * Identity versus freshness.
 *
 * Everything {@link resolveCachedDownload} parks in the URL-keyed downloads
 * cache is identified by a sha256 of its bytes, recorded in the `.cache.json`
 * sidecar beside the file. HTTP validators (ETag / Last-Modified) are
 * *freshness* data only: a CDN swap or a repository migration rotates them
 * while the bytes stay byte-identical, so a validator must never leak into an
 * artifact id.
 *
 * That claim is scoped to this entry point, not to the `downloads/` directory.
 * Callers that reach for raw {@link downloadToCache} - the version service's
 * Mojang jars, the mapping service's mapping archives - park files under the
 * same root, write no sidecar, and keep their own identity on purpose: a Mojang
 * artifact already carries an upstream SHA-1 contract, and a version jar keeps
 * an `mtimeMs:size` signature. They are a different cache layer, not a
 * migration this module is waiting on. Artifacts on local disk outside the
 * cache entirely (`~/.m2`, the Gradle module cache) are identified by their
 * bytes as well - see `contentSignature` in `source-resolver.ts`, which reuses
 * {@link digestFile} to get there.
 */

export interface DownloadResult {
  ok: boolean;
  statusCode?: number;
  /**
   * True only for an HTTP 304 answer to a conditional request. `ok` stays false
   * because no bytes were written; callers that send no validators can never
   * observe it.
   */
  notModified?: boolean;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  path?: string;
}

export interface DownloadOptions {
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
  /** Extra request headers, e.g. the conditional validators of a revalidation. */
  requestHeaders?: Record<string, string>;
}

/**
 * How a cached download may be reused.
 *
 * - `"immutable"`: the bytes behind the URL can never change, so a cached file
 *   is authoritative and no request is made.
 * - `"revalidate"`: the bytes may change, so a cached file is confirmed with a
 *   conditional request before it is reused.
 */
export type CacheFreshness = "immutable" | "revalidate";

/**
 * Where the bytes of a successful {@link resolveCachedDownload} came from.
 *
 * - `"downloaded"`: written by this call.
 * - `"hit"`: served from cache with no request at all (an immutable url).
 * - `"revalidated"`: the repository confirmed the cached bytes with a 304.
 * - `"stale"`: revalidation failed *transiently* - the request threw, the
 *   repository answered 5xx, or we were rate limited - and the cached bytes
 *   were served anyway. Byte for byte they are as good as a `"hit"`, but
 *   nothing confirmed them on this call, which is exactly the difference a
 *   caller reporting freshness (or a test pinning the fallback) needs to see.
 *   A *definitive* rejection never lands here: see
 *   {@link DEFINITIVE_REJECTION_STATUS_CODES}.
 */
export type DownloadCacheStatus = "downloaded" | "hit" | "revalidated" | "stale";

export interface CachedDownloadSuccess {
  ok: true;
  cacheStatus: DownloadCacheStatus;
  statusCode?: number;
  /** The cached file. Always present on success, cache hit or not. */
  path: string;
  /** The real on-disk byte count. Never a Content-Length header value. */
  contentLength: number;
  /** sha256 of the bytes on disk. The identity of this artifact. */
  contentSha256: string;
  /** Freshness data only. Never feed this into an identity hash. */
  etag?: string;
  /** Freshness data only. Never feed this into an identity hash. */
  lastModified?: string;
}

export interface CachedDownloadFailure {
  ok: false;
  statusCode?: number;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
}

/**
 * The result of a cache-aware download. The success arm carries `path`,
 * `contentLength` and `contentSha256` no matter which leg produced it, so a
 * caller cannot accidentally derive a different identity for a cache hit than
 * for a fresh download.
 */
export type CachedDownloadResult = CachedDownloadSuccess | CachedDownloadFailure;

/**
 * Sidecar schema generation.
 *
 * v1 recorded only `contentLength` beside the digest, which bound the record to
 * the *size* of the bytes rather than to the bytes: a jar replaced by a
 * different jar of the same length kept reporting the old digest, so the
 * artifact id described content nobody would read. v2 adds `contentMtimeMs`.
 * Bumping rather than tolerating the older shape is the point - a v1 record is
 * read as absent (re-hash), never as this file's identity.
 */
const DOWNLOAD_SIDECAR_VERSION = 2;
const DOWNLOAD_SIDECAR_SUFFIX = ".cache.json";

/**
 * Statuses that are a repository's definitive answer about this artifact rather
 * than a passing failure.
 *
 * - 404: it is not here.
 * - 410: it was here and is deliberately gone.
 * - 403: it is refused - the routine answer of an object-store-backed Maven
 *   mirror for an object that is missing when listing is denied.
 *
 * None of them get the stale-if-error fallback. Serving the cached copy would
 * hide the withdrawal for as long as the file survives and, because the caller
 * reads success, would stop the repository loop from ever asking the next
 * repository - which may still publish the artifact.
 *
 * Everything else keeps the fallback, including 401 and 400: those say something
 * about our *request* (an expired credential, a proxy mangling it), not about
 * whether this artifact exists, and dropping bytes we already hold over one
 * would be a self-inflicted outage. 408/425/429 and 5xx are transient by
 * definition, as is a thrown network error.
 */
const DEFINITIVE_REJECTION_STATUS_CODES: ReadonlySet<number> = new Set([403, 404, 410]);

function isDefinitiveRejection(statusCode: number | undefined): boolean {
  return statusCode !== undefined && DEFINITIVE_REJECTION_STATUS_CODES.has(statusCode);
}

/** The persisted identity and freshness record for one cached download. */
export interface DownloadSidecar {
  version: number;
  url: string;
  contentSha256: string;
  contentLength: number;
  /**
   * `mtimeMs` of the described file when the record was written. Together with
   * `contentLength` this is what binds the digest to a specific set of bytes, so
   * a replacement - accidental or racing - retires the record instead of
   * outliving the bytes it describes.
   */
  contentMtimeMs: number;
  etag?: string;
  lastModified?: string;
}

/** Location of the sidecar describing `destinationPath`. Destination-adjacent. */
export function downloadSidecarPath(destinationPath: string): string {
  return `${destinationPath}${DOWNLOAD_SIDECAR_SUFFIX}`;
}

/** Suffix of the temp file an in-flight sidecar write holds before its rename. */
const DOWNLOAD_SIDECAR_TEMP_SUFFIX = ".tmp";

/** The temp path {@link writeDownloadSidecar} fills before renaming into place. */
function downloadSidecarTempPath(destinationPath: string): string {
  const unique = randomBytes(4).toString("hex");
  return `${downloadSidecarPath(destinationPath)}.${unique}${DOWNLOAD_SIDECAR_TEMP_SUFFIX}`;
}

/**
 * Whether `filePath` is a download sidecar - finished or half-written - rather
 * than a downloaded artifact.
 *
 * This module owns the sidecar naming scheme, so consumers that walk the
 * download cache (the cache registry inventory) ask here instead of matching
 * the suffix themselves. The in-flight form counts: a process killed inside
 * {@link writeDownloadSidecar} leaves `<jar>.cache.json.<hex>.tmp`, which is
 * still a description of a jar and must never be inventoried as a cached
 * artifact in its own right. Widening the predicate rather than renaming the
 * temp into the plain suffix is what also covers the leftovers already sitting
 * in caches written by earlier builds - the only leftovers that exist today.
 *
 * The jar temps {@link downloadToCache} writes (`<jar>.<hex>.tmp`, no sidecar
 * suffix) are deliberately not matched: those are truncated *artifacts*, and
 * the inventory has always listed them as such.
 */
export function isDownloadSidecarPath(filePath: string): boolean {
  if (filePath.endsWith(DOWNLOAD_SIDECAR_SUFFIX)) {
    return true;
  }
  if (!filePath.endsWith(DOWNLOAD_SIDECAR_TEMP_SUFFIX)) {
    return false;
  }
  const withoutTempSuffix = filePath.slice(0, -DOWNLOAD_SIDECAR_TEMP_SUFFIX.length);
  const uniqueStart = withoutTempSuffix.lastIndexOf(".");
  return uniqueStart > 0 && withoutTempSuffix.slice(0, uniqueStart).endsWith(DOWNLOAD_SIDECAR_SUFFIX);
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function requireHttpUrl(url: string): void {
  if (!isHttpUrl(url)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported scheme for download URL: ${url}`,
      details: { url }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function retryDelay(baseMs: number, attempt: number): number {
  return Math.floor(baseMs * 2 ** attempt + Math.random() * 128);
}

/** Upper bound on how long a repository-supplied `Retry-After` may pause a retry. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Stream the file through sha256 so a multi-hundred-megabyte jar never lands in memory. */
export async function digestFile(filePath: string): Promise<{ contentSha256: string; contentLength: number }> {
  const hash = createHash("sha256");
  let contentLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    contentLength += buffer.length;
  }
  return { contentSha256: hash.digest("hex"), contentLength };
}

/** The identity of the bytes at `filePath`: their digest, and the stat that pins it to them. */
type FileIdentity = Pick<DownloadSidecar, "contentSha256" | "contentLength" | "contentMtimeMs">;

/**
 * Derive the identity of the file at `filePath`.
 *
 * The stat is taken *before* the digest on purpose. If the bytes are replaced
 * while we are hashing them, the mtime we recorded is the one they no longer
 * have, so the record we write is rejected on the next read and the digest is
 * re-derived - a wasted hash, never a wrong identity. Stamping afterwards would
 * pair a digest of mixed bytes with a stat that vouches for it.
 */
async function describeFile(filePath: string): Promise<FileIdentity> {
  const stats = statSync(filePath);
  const digest = await digestFile(filePath);
  return {
    contentSha256: digest.contentSha256,
    contentLength: stats.size,
    contentMtimeMs: stats.mtimeMs
  };
}

/**
 * Whether `sidecar`'s recorded identity still matches the bytes currently at
 * `destinationPath`. `sidecar` is always read before the network request that
 * motivated the caller to ask, so a concurrent resolve of the same mutable
 * coordinate can have replaced the file in between - this is a stat, not a
 * read, the same cross-check `readDownloadSidecar` applies on an ordinary hit.
 */
function sidecarStillCurrent(destinationPath: string, sidecar: DownloadSidecar | undefined): boolean {
  if (!sidecar) {
    return false;
  }
  try {
    const current = statSync(destinationPath);
    return current.size === sidecar.contentLength && current.mtimeMs === sidecar.contentMtimeMs;
  } catch {
    return false;
  }
}

/**
 * Read the sidecar defensively: a missing, corrupt, partial, foreign-URL,
 * older-schema or stat-mismatched record is reported as absent so the caller
 * re-derives the digest from the bytes instead of trusting a record that may
 * describe something else.
 */
function readDownloadSidecar(destinationPath: string, url: string): DownloadSidecar | undefined {
  const sidecarPath = downloadSidecarPath(destinationPath);
  if (!existsSync(sidecarPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as Partial<DownloadSidecar>;
    if (parsed.version !== DOWNLOAD_SIDECAR_VERSION || parsed.url !== url) {
      return undefined;
    }
    if (typeof parsed.contentSha256 !== "string" || parsed.contentSha256.length === 0) {
      return undefined;
    }
    if (typeof parsed.contentLength !== "number" || !Number.isFinite(parsed.contentLength)) {
      return undefined;
    }
    if (typeof parsed.contentMtimeMs !== "number" || !Number.isFinite(parsed.contentMtimeMs)) {
      return undefined;
    }
    if (parsed.etag !== undefined && typeof parsed.etag !== "string") {
      return undefined;
    }
    if (parsed.lastModified !== undefined && typeof parsed.lastModified !== "string") {
      return undefined;
    }
    // Cross-check against the bytes the record claims to describe: a truncated
    // or externally replaced file makes the recorded digest a lie. Size alone
    // cannot see a same-length replacement - a different jar swapped in by hand,
    // or installed by a concurrent resolve inside this module's own
    // sidecar-less window - so the mtime has to match too. That is a stat, not a
    // read: a cache hit stays free, which is the entire reason the record exists.
    const stats = statSync(destinationPath);
    if (stats.size !== parsed.contentLength || stats.mtimeMs !== parsed.contentMtimeMs) {
      return undefined;
    }

    return {
      version: DOWNLOAD_SIDECAR_VERSION,
      url,
      contentSha256: parsed.contentSha256,
      contentLength: parsed.contentLength,
      contentMtimeMs: parsed.contentMtimeMs,
      etag: parsed.etag,
      lastModified: parsed.lastModified
    };
  } catch {
    // Corrupt record -> treat as absent and re-derive.
    return undefined;
  }
}

/**
 * Write the sidecar atomically (temp file + rename).
 *
 * Ordering matters, in both directions. Bytes are always written before the
 * sidecar that describes them, and a sidecar describing bytes that are about to
 * be replaced is retired first ({@link retireDownloadSidecar}). A crash can
 * therefore only ever leave a sidecar-less file - re-hashed on the next read -
 * never a sidecar describing a file that is not there. A failure to write is
 * swallowed on purpose: the cached bytes are still usable and the next call
 * simply re-derives the digest.
 */
function writeDownloadSidecar(destinationPath: string, sidecar: DownloadSidecar): void {
  const sidecarPath = downloadSidecarPath(destinationPath);
  const tempPath = downloadSidecarTempPath(destinationPath);
  try {
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(sidecar));
    renameSync(tempPath, sidecarPath);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Delete the record describing `destinationPath`, reporting whether one was
 * there to delete.
 *
 * This opens a deliberately sidecar-less window around a byte replacement: for
 * the length of the transfer the file has no identity record at all, a state the
 * read path handles by re-deriving the digest, instead of a record describing
 * bytes that no longer exist, which it can only catch when the sizes happen to
 * differ.
 */
function retireDownloadSidecar(destinationPath: string): boolean {
  try {
    unlinkSync(downloadSidecarPath(destinationPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Evict a cached download and its identity record.
 *
 * For a caller that got its bytes and then found them unusable - a 200 carrying
 * an HTML error page instead of a jar, say. The transfer succeeded, so nothing
 * in here can tell it apart from a real artifact, and for an immutable url the
 * entry would otherwise be served straight back on every later run with no
 * request made at all: the poison would outlive the outage that produced it.
 *
 * Record first, bytes second, matching {@link writeDownloadSidecar}'s ordering
 * in reverse: no window ever holds a record describing bytes that are gone. Both
 * steps are best-effort - a file we could not remove is at worst re-validated
 * and re-evicted next time.
 */
export function discardCachedDownload(destinationPath: string): void {
  retireDownloadSidecar(destinationPath);
  try {
    unlinkSync(destinationPath);
  } catch {
    // best-effort eviction
  }
}

function conditionalHeadersFor(sidecar: DownloadSidecar | undefined): Record<string, string> | undefined {
  if (!sidecar) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  if (sidecar.etag) {
    headers["If-None-Match"] = sidecar.etag;
  }
  if (sidecar.lastModified) {
    headers["If-Modified-Since"] = sidecar.lastModified;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Reuse the bytes already on disk, deriving (and persisting) the digest if needed. */
async function cachedBytesResult(
  url: string,
  destinationPath: string,
  sidecar: DownloadSidecar | undefined,
  cacheStatus: DownloadCacheStatus
): Promise<CachedDownloadSuccess> {
  if (sidecar) {
    return {
      ok: true,
      cacheStatus,
      path: destinationPath,
      contentLength: sidecar.contentLength,
      contentSha256: sidecar.contentSha256,
      etag: sidecar.etag,
      lastModified: sidecar.lastModified
    };
  }

  // Migration path: a jar cached by an older build has no readable sidecar -
  // none at all, or one this build refuses. Hash it once and record the result
  // so every later hit is free. No freshness data is carried out of here: a
  // rejected record's validators are exactly as untrustworthy as its digest.
  const identity = await describeFile(destinationPath);
  writeDownloadSidecar(destinationPath, {
    version: DOWNLOAD_SIDECAR_VERSION,
    url,
    ...identity
  });
  return {
    ok: true,
    cacheStatus,
    path: destinationPath,
    contentLength: identity.contentLength,
    contentSha256: identity.contentSha256
  };
}

/**
 * Bytes of the file at `filePath`, or 0 when there is none.
 *
 * A zero-byte file is reported exactly like a missing one, on purpose: an empty
 * artifact is never a usable cache entry - it fails the moment a decompiler or
 * a zip reader opens it - so it must satisfy neither an immutable hit nor a
 * stale-if-error fallback. Treating it as absent lets the next transfer replace
 * it instead of pinning it forever.
 */
function cachedByteCount(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve a URL into a cached file, deciding here - inside the module that owns
 * the download cache - whether the network is needed at all.
 *
 * `freshness: "immutable"` never asks the network once the file exists.
 * `freshness: "revalidate"` confirms known validators with a conditional
 * request and keeps the cached bytes on a 304. When revalidation fails
 * *transiently* (offline repo, 5xx, rate limiting) the cached bytes are still
 * served - they are a byte-exact copy of what the repository handed out before,
 * and losing them to a passing failure would be a regression over the previous
 * unconditional "file exists -> reuse it" behaviour - but they are reported as
 * `cacheStatus: "stale"`, never as a confirmed hit. A definitive rejection
 * ({@link DEFINITIVE_REJECTION_STATUS_CODES}) is reported as the failure it is,
 * so the caller can fail over to another repository.
 *
 * A zero-byte answer is refused rather than cached: see {@link cachedByteCount}.
 *
 * @param url - The artifact URL; also the identity the sidecar is bound to.
 * @param destinationPath - Where the bytes live; the sidecar sits next to it.
 * @param options - Download options plus the required freshness policy.
 * @returns A result whose success arm always carries `path`, the real on-disk
 *   `contentLength`, and `contentSha256`, regardless of which leg produced it.
 */
export async function resolveCachedDownload(
  url: string,
  destinationPath: string,
  options: DownloadOptions & { freshness: CacheFreshness }
): Promise<CachedDownloadResult> {
  requireHttpUrl(url);

  const { freshness, requestHeaders, ...downloadOptions } = options;
  const hasCachedBytes = cachedByteCount(destinationPath) > 0;
  const sidecar = hasCachedBytes ? readDownloadSidecar(destinationPath, url) : undefined;

  if (hasCachedBytes && freshness === "immutable") {
    return await cachedBytesResult(url, destinationPath, sidecar, "hit");
  }

  const conditional = freshness === "revalidate" ? conditionalHeadersFor(sidecar) : undefined;
  const mergedHeaders = { ...(requestHeaders ?? {}), ...(conditional ?? {}) };

  // The 200 leg below renames replacement bytes over `destinationPath`, and
  // digesting a multi-hundred-megabyte jar afterwards is not instant. Retire the
  // record of the OLD bytes before the transfer starts, so that whole window
  // holds no sidecar at all rather than one describing bytes that are gone - the
  // size cross-check in readDownloadSidecar only catches the latter when the
  // sizes happen to differ. `sidecar` is already in memory, so it still supplies
  // the conditional validators, and every leg that keeps the old bytes puts the
  // record straight back.
  const retiredSidecar = hasCachedBytes ? retireDownloadSidecar(destinationPath) : false;

  /**
   * Reuse the bytes already on disk, restoring the retired record first.
   *
   * `sidecar` was read before the transfer attempt went out, so a concurrent
   * resolve of the same mutable coordinate can have replaced `destinationPath`
   * while this request was in flight - trust `sidecar`'s identity only if the
   * file still matches it, the same check the notModified branch below
   * applies, otherwise re-derive from whatever bytes are actually there.
   *
   * Returns undefined instead of throwing: every caller of this is already on a
   * failure path, and a second failure here (the file was pruned between the
   * stat and the read, the disk is unreadable) must not replace the reason the
   * call failed with a less informative one.
   */
  const serveCachedBytes = async (
    cacheStatus: DownloadCacheStatus
  ): Promise<CachedDownloadSuccess | undefined> => {
    if (!hasCachedBytes) {
      return undefined;
    }
    try {
      const usable = sidecarStillCurrent(destinationPath, sidecar) ? sidecar : undefined;
      if (retiredSidecar && usable) {
        writeDownloadSidecar(destinationPath, usable);
      }
      return await cachedBytesResult(url, destinationPath, usable, cacheStatus);
    } catch {
      return undefined;
    }
  };

  let downloaded: DownloadResult;
  try {
    downloaded = await downloadToCache(url, destinationPath, {
      ...downloadOptions,
      requestHeaders: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined
    });
  } catch (caughtError) {
    // Stale-if-error: a byte-exact copy of what the repository handed out before
    // beats failing outright, as long as the caller is told it is unconfirmed.
    const stale = await serveCachedBytes("stale");
    if (stale) {
      return stale;
    }
    throw caughtError;
  }

  if (downloaded.notModified && hasCachedBytes) {
    // `sidecar` was read before the conditional request went out, so a
    // concurrent resolve of the same mutable coordinate can have replaced
    // `destinationPath` while this request was in flight - the 304 we just
    // got answers for the OLD bytes. Trust `sidecar`'s identity only if the
    // file still matches it; otherwise re-derive from what's actually there,
    // the same stat-then-digest check readDownloadSidecar applies on read.
    const identity: DownloadSidecar =
      sidecar !== undefined && sidecarStillCurrent(destinationPath, sidecar)
        ? sidecar
        : {
            version: DOWNLOAD_SIDECAR_VERSION,
            url,
            ...(await describeFile(destinationPath))
          };
    const refreshed: DownloadSidecar = {
      ...identity,
      etag: downloaded.etag ?? identity.etag,
      lastModified: downloaded.lastModified ?? identity.lastModified
    };
    writeDownloadSidecar(destinationPath, refreshed);
    return {
      ok: true,
      cacheStatus: "revalidated",
      statusCode: downloaded.statusCode,
      path: destinationPath,
      contentLength: refreshed.contentLength,
      contentSha256: refreshed.contentSha256,
      etag: refreshed.etag,
      lastModified: refreshed.lastModified
    };
  }

  if (!downloaded.ok || !downloaded.path) {
    if (isDefinitiveRejection(downloaded.statusCode)) {
      // The repository has answered about this artifact, not about its own
      // health, and it will answer the same way next time. Report the failure so
      // the caller's repository loop can move on; a cached copy standing in here
      // would look like success and end the search at a repository that has
      // nothing. The bytes stay on disk - evicting the last copy in reach is not
      // this module's call - and the record goes back with them, so a later
      // revalidation that finds the artifact restored still has its validators.
      if (retiredSidecar && sidecar) {
        writeDownloadSidecar(destinationPath, sidecar);
      }
      return {
        ok: false,
        statusCode: downloaded.statusCode,
        etag: downloaded.etag,
        lastModified: downloaded.lastModified,
        contentLength: downloaded.contentLength
      };
    }

    // The same stale-if-error reuse, for a repository that answered rather than
    // failed to: a 5xx, a 429, an authentication hiccup. Nothing here says the
    // artifact is gone, so bytes we already hold beat failing outright.
    const stale = await serveCachedBytes("stale");
    if (stale) {
      return stale;
    }
    return {
      ok: false,
      statusCode: downloaded.statusCode,
      etag: downloaded.etag,
      lastModified: downloaded.lastModified,
      contentLength: downloaded.contentLength
    };
  }

  // Bytes first, sidecar second - see writeDownloadSidecar.
  const digest = await describeFile(downloaded.path);
  if (digest.contentLength === 0) {
    // A 200 with no body is a failed transfer that happened to answer success.
    // Recording it would park an empty artifact under this url - permanently, if
    // the url is immutable - and every later hit would hand back bytes that only
    // fail once something opens them. Drop the file and report the failure, so
    // the next call transfers again instead of inheriting the emptiness.
    try {
      unlinkSync(downloaded.path);
    } catch {
      // Best-effort: an empty file we could not remove is at least sidecar-less,
      // and cachedByteCount refuses to treat it as a cache hit either way.
    }
    return {
      ok: false,
      statusCode: downloaded.statusCode,
      etag: downloaded.etag,
      lastModified: downloaded.lastModified,
      contentLength: 0
    };
  }
  writeDownloadSidecar(downloaded.path, {
    version: DOWNLOAD_SIDECAR_VERSION,
    url,
    ...digest,
    etag: downloaded.etag,
    lastModified: downloaded.lastModified
  });

  return {
    ok: true,
    cacheStatus: "downloaded",
    statusCode: downloaded.statusCode,
    path: downloaded.path,
    contentLength: digest.contentLength,
    contentSha256: digest.contentSha256,
    etag: downloaded.etag,
    lastModified: downloaded.lastModified
  };
}

/**
 * Fetch `url` unconditionally and stream it into `destinationPath`.
 *
 * This is the raw transfer: it knows nothing about what is already cached.
 * Prefer {@link resolveCachedDownload} for anything keyed by URL in the
 * downloads cache.
 */
export async function downloadToCache(
  url: string,
  destinationPath: string,
  opts: DownloadOptions = {}
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxRetries = opts.retries ?? 2;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  requireHttpUrl(url);

  mkdirSync(dirname(destinationPath), { recursive: true });

  let attempt = 0;
  while (true) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);

    try {
      const request: RequestInit = { signal: timeout.signal };
      if (opts.requestHeaders && Object.keys(opts.requestHeaders).length > 0) {
        request.headers = opts.requestHeaders;
      }
      const response = await fetchFn(url, request);

      const status = response.status;
      if (status === 404) {
        return { ok: false, statusCode: status };
      }

      // A conditional request that the server answered with "unchanged". Not an
      // error: the caller already holds the bytes. `ok` stays false because this
      // call wrote none.
      if (status === 304) {
        return {
          ok: false,
          statusCode: status,
          notModified: true,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined
        };
      }

      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt >= maxRetries) {
          return { ok: false, statusCode: status };
        }

        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        // A repository-supplied Retry-After is a hint, not a mandate: an
        // unreasonable value (or a hostile one) must not stall the caller far
        // past what a retry is worth, so it is capped rather than trusted whole.
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
            : retryDelay(200, attempt);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          statusCode: status,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
          contentLength: Number.parseInt(response.headers.get("content-length") ?? "0", 10)
        };
      }

      const tempPath = `${destinationPath}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        if (!response.body) {
          writeFileSync(tempPath, Buffer.alloc(0));
        } else {
          const readable = Readable.fromWeb(response.body as unknown as any);
          await pipeline(readable, createWriteStream(tempPath), { signal: timeout.signal });
        }

        const contentLength = statSync(tempPath).size;

        // A 200 with no body is a failed transfer that happened to answer
        // success. Renaming it onto `destinationPath` before this is known would
        // overwrite any good bytes already cached there - the caller's
        // stale-if-error fallback below only has bytes to fall back to if this
        // leg never destroys them. Report it exactly like any other failed leg
        // instead: no `path`, `ok: false`, temp file discarded.
        if (contentLength === 0) {
          try {
            unlinkSync(tempPath);
          } catch {
            // best-effort cleanup
          }
          return {
            ok: false,
            statusCode: status,
            etag: response.headers.get("etag") ?? undefined,
            lastModified: response.headers.get("last-modified") ?? undefined,
            contentLength: 0
          };
        }

        renameSync(tempPath, destinationPath);

        return {
          ok: true,
          statusCode: status,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
          contentLength,
          path: destinationPath
        };
      } catch (streamError) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort cleanup
        }
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }
    } catch (caughtError) {
      if (attempt >= maxRetries) {
        throw caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      }

      await sleep(retryDelay(200, attempt));
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function defaultDownloadPath(cacheDir: string, url: string): string {
  const filename = `${sha256(url)}.jar`;
  return `${cacheDir}/downloads/${filename}`;
}
