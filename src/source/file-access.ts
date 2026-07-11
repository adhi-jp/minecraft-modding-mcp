import { basename } from "node:path";

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

// Read-through delivery for non-indexed jar resources: text files under these
// prefixes are served directly from the backing jar when the source index has
// no row for them. The per-file cap bounds response size; binary entries
// answer with metadata only.
const READ_THROUGH_PREFIXES = ["assets/", "data/"] as const;
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
  ".glsl"
]);
const NEARBY_PATH_HINT_LIMIT = 5;

function isTraversalShapedPath(filePath: string): boolean {
  return (
    filePath.startsWith("/") ||
    filePath.includes("\u0000") ||
    filePath.split(/[\\/]/).includes("..")
  );
}

function hasReadThroughPrefix(filePath: string): boolean {
  return READ_THROUGH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function readThroughTextExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return READ_THROUGH_TEXT_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
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
      .filter((entry) => hasReadThroughPrefix(entry) && basename(entry) === wanted)
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
    if (!row && hasReadThroughPrefix(normalizedPath) && artifact.binaryJarPath) {
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
        details: { artifactId: input.artifactId, filePath: input.filePath }
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
  const isText = readThroughTextExtension(filePath);
  const cap = isText
    ? Math.min(
        clampLimit(args.maxBytes, svc.config.maxContentBytes, Number.MAX_SAFE_INTEGER),
        READ_THROUGH_MAX_BYTES
      )
    : 0;
  let capped: CappedJarEntry;
  try {
    // Read at most the cap (+ slack to trim back to a UTF-8 boundary); an
    // oversized entry is never fully materialized in memory. Binary entries
    // are metadata-only probes (no content read at all).
    capped = await readJarEntryCapped(binaryJarPath, filePath, isText ? cap + 4 : 0);
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

  if (!isText) {
    return {
      ...base,
      content: "",
      contentBytes: capped.entrySize,
      truncated: false,
      contentOmittedReason:
        "Entry is not a known text format; binary content is not delivered. Size and existence are reported instead."
    };
  }

  const truncated = capped.entrySize > cap;
  let content: string;
  if (truncated) {
    // Trim the capped prefix back to a UTF-8 character boundary before
    // decoding; the tail past the cap is dropped by design.
    const buffer = capped.buffer;
    let cut = Math.min(cap, buffer.length);
    while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) {
      cut -= 1;
    }
    content = buffer.slice(0, cut).toString("utf8");
  } else {
    content = decodeJarEntryUtf8OrThrow(capped.buffer, binaryJarPath, filePath);
  }
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
    if (
      normalizedPrefix &&
      page.items.length === 0 &&
      (normalizedPrefix.startsWith("assets/") || normalizedPrefix.startsWith("data/"))
    ) {
      warnings.push(
        "Indexed artifacts currently include Java source only; non-Java resources are not indexed. Text files under assets/ and data/ are served directly from the backing jar — request them by exact path with get-artifact-file (read-through delivery)."
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
