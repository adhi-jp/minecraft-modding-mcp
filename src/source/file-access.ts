import { basename } from "node:path";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError, isAppError } from "../errors.js";
import { log } from "../logger.js";
import {
  decodeJarEntryUtf8OrThrow,
  listJarEntries,
  readJarEntryCapped,
  type CappedJarEntry
} from "../source-jar-reader.js";
import type { SourceService } from "../source-service.js";
import type {
  GetArtifactFileInput,
  GetArtifactFileOutput,
  ListArtifactFilesInput,
  ListArtifactFilesOutput
} from "../source-service.js";
import { normalizeOptionalString, normalizePathStyle } from "./shared-utils.js";

// Read-through delivery for non-indexed jar resources: any entry of the
// backing jar is served directly when the source index has no row for it.
//
// Delivery used to be gated on an `assets/`+`data/` path prefix, which made the
// two entries an agent reaches for FIRST when inspecting a mod jar —
// `fabric.mod.json` at the archive root and `META-INF/MANIFEST.MF` — permanently
// unreachable (ERR_FILE_NOT_FOUND) even though `assets/**` read-through proved
// the mechanism worked. The prefix carries no safety value: the real guards are
// the traversal-shaped path rejection, the per-file byte cap, and the
// text/binary classification below, and all three apply to every entry alike.
const READ_THROUGH_MAX_BYTES = 512 * 1024;
const READ_THROUGH_TEXT_EXTENSIONS = new Set([
  ".json",
  ".mcmeta",
  ".txt",
  ".properties",
  ".lang",
  ".cfg",
  ".toml",
  ".snbt",
  ".yml",
  ".yaml",
  ".csv",
  ".md",
  ".fsh",
  ".vsh",
  ".glsl",
  // Loader metadata that lives outside assets/ and data/.
  ".mf",
  ".accesswidener",
  ".xml"
]);
/**
 * Extensions known to hold non-text payloads. Listing them keeps the common
 * case a metadata-only probe: no bytes are read at all.
 */
const READ_THROUGH_BINARY_EXTENSIONS = new Set([
  ".class",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".ico",
  ".jar",
  ".zip",
  ".gz",
  ".tar",
  ".ogg",
  ".wav",
  ".mp3",
  ".nbt",
  ".dat",
  ".bin",
  ".so",
  ".dll",
  ".dylib",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".pack",
  ".mca",
  ".rsa",
  ".dsa"
]);
const NEARBY_PATH_HINT_LIMIT = 5;
/** Ratio of C0 control bytes above which a sniffed entry counts as binary. */
const SNIFF_MAX_CONTROL_RATIO = 0.05;

function isTraversalShapedPath(filePath: string): boolean {
  return (
    filePath.startsWith("/") ||
    filePath.includes("\u0000") ||
    filePath.split(/[\\/]/).includes("..")
  );
}

/**
 * How an entry's bytes should be treated.
 *
 * - `text`: a known text extension. Delivered, and invalid UTF-8 is an error
 *   (a caller asking for a .json must not receive silently mangled bytes).
 * - `binary`: a known binary extension. Never read; answered with size only.
 * - `unknown`: no extension, or one not on either list. `META-INF/services/*`
 *   entries, `LICENSE`-style files and loader files with bespoke suffixes all
 *   land here, so these are sniffed from their (capped) bytes rather than
 *   refused on the strength of a filename.
 */
type ReadThroughKind = "text" | "binary" | "unknown";

function classifyReadThroughEntry(filePath: string): ReadThroughKind {
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  if (dot < 0 || dot < slash) {
    return "unknown";
  }
  const extension = filePath.slice(dot).toLowerCase();
  if (READ_THROUGH_TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (READ_THROUGH_BINARY_EXTENSIONS.has(extension)) {
    return "binary";
  }
  return "unknown";
}

/**
 * Decodes a capped buffer when it really is UTF-8 text, else reports binary.
 * A NUL byte, a strict-UTF-8 decode failure, or a high C0 control-byte ratio
 * all mean "do not hand this back as text".
 */
function sniffUtf8Text(buffer: Buffer): string | undefined {
  if (buffer.length === 0) {
    return "";
  }
  if (buffer.includes(0)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
  let control = 0;
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      control += 1;
    }
  }
  return control / buffer.length > SNIFF_MAX_CONTROL_RATIO ? undefined : decoded;
}

/** Trims a capped buffer back to a UTF-8 character boundary at `limit`. */
function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
  let cut = Math.min(limit, buffer.length);
  while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buffer.subarray(0, cut);
}

/**
 * Same-basename entries elsewhere in the jar, for not-found hints. Covers
 * directory relocations across versions (e.g. assets/minecraft/models/item/*
 * moving to assets/minecraft/items/*).
 */
async function collectNearbyPaths(binaryJarPath: string, missingPath: string): Promise<string[]> {
  try {
    const wanted = basename(missingPath);
    const entries = await listJarEntries(binaryJarPath);
    return entries
      .filter((entry) => basename(entry) === wanted)
      .slice(0, NEARBY_PATH_HINT_LIMIT);
  } catch {
    return [];
  }
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || limit === null) {
    return fallback;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), max);
}

function truncateUtf8ToMaxBytes(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  const buffer = Buffer.from(content, "utf8");
  let cut = Math.min(maxBytes, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buffer.slice(0, cut).toString("utf8");
}

export async function getArtifactFile(svc: SourceService, input: GetArtifactFileInput): Promise<GetArtifactFileOutput> {
  const startedAt = Date.now();
  try {
    if (isTraversalShapedPath(input.filePath)) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `filePath "${input.filePath}" must be a plain in-archive path (no absolute paths or ".." segments).`,
        details: {
          filePath: input.filePath,
          nextAction: "Pass the entry path exactly as it appears inside the jar, e.g. assets/minecraft/models/block/stone.json."
        }
      });
    }
    const artifact = svc.getArtifact(input.artifactId);
    const normalizedPath = normalizePathStyle(input.filePath);
    const row = svc.filesRepo.getFileContent(artifact.artifactId, normalizedPath);
    if (!row && artifact.binaryJarPath) {
      return await readFileThroughJar(svc, {
        artifact,
        binaryJarPath: artifact.binaryJarPath,
        filePath: normalizedPath,
        maxBytes: input.maxBytes,
        artifactId: input.artifactId
      });
    }
    if (!row) {
      throw createError({
        code: ERROR_CODES.FILE_NOT_FOUND,
        message: `Source file "${input.filePath}" was not found.`,
        details: {
          artifactId: input.artifactId,
          filePath: input.filePath,
          nextAction:
            "This artifact has no backing binary jar, so only indexed source files are reachable. List what is indexed with list-artifact-files.",
          ...buildSuggestedCall({
            tool: "list-artifact-files",
            params: { artifactId: input.artifactId, limit: 50 }
          })
        }
      });
    }

    const maxBytes = clampLimit(input.maxBytes, svc.config.maxContentBytes, Number.MAX_SAFE_INTEGER);
    const fullBytes = Buffer.byteLength(row.content, "utf8");
    const truncated = fullBytes > maxBytes;
    const content = truncated ? truncateUtf8ToMaxBytes(row.content, maxBytes) : row.content;

    if (truncated) {
      log("warn", "source.get_file.truncated", {
        artifactId: input.artifactId,
        filePath: input.filePath,
        maxBytes,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        fullBytes
      });
    }

    return {
      filePath: row.filePath,
      content,
      contentBytes: fullBytes,
      truncated,
      mappingApplied: artifact.mappingApplied ?? "obfuscated",
      returnedNamespace: artifact.mappingApplied ?? "obfuscated",
      artifactContents: svc.buildArtifactContentsSummary({
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        isDecompiled: artifact.isDecompiled,
        qualityFlags: artifact.qualityFlags
      })
    };
  } finally {
    svc.metrics.recordDuration("get_file_duration_ms", Date.now() - startedAt);
  }
}

async function readFileThroughJar(
  svc: SourceService,
  args: {
    artifact: ReturnType<SourceService["getArtifact"]>;
    binaryJarPath: string;
    filePath: string;
    maxBytes: number | undefined;
    artifactId: string;
  }
): Promise<GetArtifactFileOutput> {
  const { artifact, binaryJarPath, filePath, artifactId } = args;
  const kind = classifyReadThroughEntry(filePath);
  const cap =
    kind === "binary"
      ? 0
      : Math.min(
          clampLimit(args.maxBytes, svc.config.maxContentBytes, Number.MAX_SAFE_INTEGER),
          READ_THROUGH_MAX_BYTES
        );
  let capped: CappedJarEntry;
  try {
    // Read at most the cap (+ slack to trim back to a UTF-8 boundary); an
    // oversized entry is never fully materialized in memory. Known-binary
    // entries are metadata-only probes (no content read at all).
    capped = await readJarEntryCapped(binaryJarPath, filePath, kind === "binary" ? 0 : cap + 4);
  } catch (error) {
    if (!isAppError(error) || error.code !== ERROR_CODES.SOURCE_NOT_FOUND) {
      // Unsafe paths and unreadable/corrupt jars are their own failures;
      // only a genuinely-missing entry becomes file-not-found with hints.
      throw error;
    }
    const nearbyPaths = await collectNearbyPaths(binaryJarPath, filePath);
    throw createError({
      code: ERROR_CODES.FILE_NOT_FOUND,
      message: `File "${filePath}" was not found in the source index or the backing jar.`,
      details: {
        artifactId,
        filePath,
        ...(nearbyPaths.length > 0
          ? {
              nearbyPaths,
              nextAction: `Same-named entries exist at: ${nearbyPaths.join(", ")}. Directory layouts move between versions; retry with one of those paths.`
            }
          : {})
      }
    });
  }

  const base = {
    filePath,
    mappingApplied: artifact.mappingApplied ?? ("obfuscated" as const),
    returnedNamespace: artifact.mappingApplied ?? ("obfuscated" as const),
    artifactContents: svc.buildArtifactContentsSummary({
      origin: artifact.origin,
      sourceJarPath: artifact.sourceJarPath,
      isDecompiled: artifact.isDecompiled,
      qualityFlags: artifact.qualityFlags
    }),
    deliveryMode: "jar-read-through" as const
  };

  const omitBinary = (reason: string): GetArtifactFileOutput => ({
    ...base,
    content: "",
    contentBytes: capped.entrySize,
    truncated: false,
    contentOmittedReason: reason
  });

  if (kind === "binary") {
    return omitBinary(
      "Entry is not a known text format; binary content is not delivered. Size and existence are reported instead."
    );
  }

  const truncated = capped.entrySize > cap;
  // Trim the capped prefix back to a UTF-8 character boundary before decoding;
  // the tail past the cap is dropped by design.
  const trimmed = truncated ? trimToUtf8Boundary(capped.buffer, cap) : capped.buffer;

  if (kind === "unknown") {
    // No extension to go on: decide from the bytes rather than refuse a text
    // entry (META-INF/services/*, LICENSE files) on the strength of its name.
    const sniffed = sniffUtf8Text(trimmed);
    if (sniffed === undefined) {
      return omitBinary(
        "Entry has no known text extension and its bytes are not UTF-8 text; binary content is not delivered. Size and existence are reported instead."
      );
    }
    return {
      ...base,
      content: sniffed,
      contentBytes: capped.entrySize,
      truncated
    };
  }

  const content = truncated
    ? trimmed.toString("utf8")
    : decodeJarEntryUtf8OrThrow(capped.buffer, binaryJarPath, filePath);
  return {
    ...base,
    content,
    contentBytes: capped.entrySize,
    truncated
  };
}

export async function listArtifactFiles(svc: SourceService, input: ListArtifactFilesInput): Promise<ListArtifactFilesOutput> {
  const startedAt = Date.now();
  try {
    const artifact = svc.getArtifact(input.artifactId);
    const limit = clampLimit(input.limit, 200, 2000);
    const warnings: string[] = [];
    const prefix = input.prefix === undefined ? undefined : normalizePathStyle(input.prefix);
    const page = svc.filesRepo.listFiles(artifact.artifactId, {
      limit,
      cursor: input.cursor,
      prefix
    });
    const normalizedPrefix = normalizeOptionalString(prefix);
    // A prefix that matched nothing is the exact moment read-through is worth
    // naming: the index holds Java source only, while EVERY jar entry —
    // archive-root files such as fabric.mod.json and META-INF/** included — is
    // reachable by exact path.
    if (normalizedPrefix && page.items.length === 0 && artifact.binaryJarPath) {
      warnings.push(
        "Indexed artifacts currently include Java source only; non-Java resources are not indexed. Any text entry of the backing jar — including archive-root files such as fabric.mod.json and META-INF/** — is served directly by exact path with get-artifact-file (read-through delivery)."
      );
    }
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      mappingApplied: artifact.mappingApplied ?? "obfuscated",
      artifactContents: svc.buildArtifactContentsSummary({
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        isDecompiled: artifact.isDecompiled,
        qualityFlags: artifact.qualityFlags
      }),
      warnings
    };
  } finally {
    svc.metrics.recordDuration("list_files_duration_ms", Date.now() - startedAt);
  }
}
