/**
 * Artifact indexing pipeline: signature checks, ingest-if-needed,
 * source-jar loading, decompile-from-binary, binary remap to Mojang
 * namespace, and persistence into the artifact/file/symbol/meta repos.
 * Behavior-preserving extraction from `src/source-service.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { decompileBinaryJar } from "../decompiler/vineflower.js";
import { ERROR_CODES, createError, isAppError } from "../errors.js";
import { log } from "../logger.js";
import { resolveMojangTinyFile } from "../mojang-tiny-mapping-service.js";
import { iterateJavaEntriesAsUtf8 } from "../source-jar-reader.js";
import type { SourceService } from "../source-service.js";
import type { ArtifactIndexMetaRow } from "../storage/index-meta-repo.js";
import type { ArtifactRow, ResolvedSourceArtifact } from "../types.js";
import { extractSymbolsFromSource } from "../symbols/symbol-extractor.js";
import { remapJar } from "../tiny-remapper-service.js";
import { resolveTinyRemapperJar } from "../tiny-remapper-resolver.js";
import { resolveVineflowerJar } from "../vineflower-resolver.js";
import {
  enforceCacheLimits,
  recordRemappedJarBytes,
  releaseRemappedJarBytes,
  touchCacheMetrics,
  upsertCacheMetrics
} from "./cache-metrics.js";

export const INDEX_SCHEMA_VERSION = 1;

export type IndexRebuildReason =
  | "force"
  | "missing_meta"
  | "schema_mismatch"
  | "signature_mismatch"
  | "already_current";

export interface IndexedFileRecord {
  filePath: string;
  content: string;
  contentBytes: number;
  contentHash: string;
}

export interface RebuiltArtifactData {
  files: IndexedFileRecord[];
  symbols: Array<{
    filePath: string;
    symbolKind: string;
    symbolName: string;
    qualifiedName: string | undefined;
    line: number;
  }>;
  indexedAt: string;
  indexDurationMs: number;
  totalContentBytes: number;
}

export type IndexArtifactInput = {
  artifactId: string;
  force?: boolean;
};

export type IndexArtifactOutput = {
  artifactId: string;
  reindexed: boolean;
  reason: IndexRebuildReason;
  counts: {
    files: number;
    symbols: number;
    ftsRows: number;
  };
  indexedAt: string;
  durationMs: number;
  mappingApplied: import("../types.js").SourceMapping;
};

function normalizePathStyle(path: string): string {
  return path.replaceAll("\\", "/");
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.trunc(chunkSize));
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function indexArtifact(svc: SourceService, input: IndexArtifactInput): Promise<IndexArtifactOutput> {
  const artifactId = input.artifactId?.trim();
  if (!artifactId) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "artifactId must be non-empty."
    });
  }

  const artifact = svc.getArtifact(artifactId);
  const force = input.force ?? false;
  const hasFiles = svc.filesRepo.listFiles(artifact.artifactId, { limit: 1 }).items.length > 0;
  const meta = svc.indexMetaRepo.get(artifact.artifactId);
  const expectedSignature = artifact.artifactSignature ?? fallbackArtifactSignature(artifact.artifactId);
  const reason = resolveIndexRebuildReason({
    force,
    expectedSignature,
    hasFiles,
    meta
  });

  if (reason === "already_current") {
    svc.metrics.recordReindexSkip();
    const currentMeta = meta as ArtifactIndexMetaRow;
    return {
      artifactId: artifact.artifactId,
      reindexed: false,
      reason,
      counts: {
        files: currentMeta.filesCount,
        symbols: currentMeta.symbolsCount,
        ftsRows: currentMeta.ftsRowsCount
      },
      indexedAt: currentMeta.indexedAt,
      durationMs: 0,
      mappingApplied: artifact.mappingApplied ?? "obfuscated"
    };
  }

  const resolved = toResolvedArtifact(svc, artifact);
  const rebuilt = await rebuildAndPersistArtifactIndex(svc, resolved, reason);
  svc.metrics.recordReindex();
  return {
    artifactId: artifact.artifactId,
    reindexed: true,
    reason,
    counts: {
      files: rebuilt.files.length,
      symbols: rebuilt.symbols.length,
      ftsRows: rebuilt.files.length
    },
    indexedAt: rebuilt.indexedAt,
    durationMs: rebuilt.indexDurationMs,
    mappingApplied: artifact.mappingApplied ?? "obfuscated"
  };
}

export function fallbackArtifactSignature(artifactId: string): string {
  return createHash("sha256").update(artifactId).digest("hex");
}

export function resolveIndexRebuildReason(input: {
  force: boolean;
  expectedSignature: string;
  hasFiles: boolean;
  meta: ArtifactIndexMetaRow | undefined;
}): IndexRebuildReason {
  if (input.force) {
    return "force";
  }
  if (!input.hasFiles || !input.meta) {
    return "missing_meta";
  }
  if (input.meta.indexSchemaVersion !== INDEX_SCHEMA_VERSION) {
    return "schema_mismatch";
  }
  if (input.meta.artifactSignature !== input.expectedSignature) {
    return "signature_mismatch";
  }
  return "already_current";
}

export function toResolvedArtifact(svc: SourceService, artifact: ArtifactRow): ResolvedSourceArtifact {
  return {
    artifactId: artifact.artifactId,
    artifactAlias: artifact.alias,
    artifactSignature: artifact.artifactSignature ?? fallbackArtifactSignature(artifact.artifactId),
    origin: artifact.origin,
    binaryJarPath: artifact.binaryJarPath,
    sourceJarPath: artifact.sourceJarPath,
    coordinate: artifact.coordinate,
    version: artifact.version,
    requestedMapping: artifact.requestedMapping,
    mappingApplied: artifact.mappingApplied,
    repoUrl: artifact.repoUrl,
    provenance: artifact.provenance,
    qualityFlags: artifact.qualityFlags,
    isDecompiled: artifact.isDecompiled,
    resolvedAt: new Date().toISOString()
  };
}

export async function rebuildAndPersistArtifactIndex(
  svc: SourceService,
  resolved: ResolvedSourceArtifact,
  reason: Exclude<IndexRebuildReason, "already_current">
): Promise<RebuiltArtifactData> {
  const rebuilt = await buildRebuiltArtifactData(svc, resolved);
  const timestamp = new Date().toISOString();
  const chunkSize = Math.max(1, svc.config.indexInsertChunkSize ?? 200);

  const tx = svc.db.transaction(() => {
    svc.artifactsRepo.upsertArtifact({
      artifactId: resolved.artifactId,
      alias: resolved.artifactAlias,
      origin: resolved.origin,
      coordinate: resolved.coordinate,
      version: resolved.version,
      binaryJarPath: resolved.binaryJarPath,
      sourceJarPath: resolved.sourceJarPath,
      repoUrl: resolved.repoUrl,
      requestedMapping: resolved.requestedMapping,
      mappingApplied: resolved.mappingApplied,
      provenance: resolved.provenance,
      qualityFlags: resolved.qualityFlags,
      artifactSignature: resolved.artifactSignature,
      isDecompiled: resolved.isDecompiled,
      timestamp
    });
    svc.filesRepo.clearFilesForArtifact(resolved.artifactId);
    for (const chunk of chunkArray(rebuilt.files, chunkSize)) {
      svc.filesRepo.insertFilesForArtifact(resolved.artifactId, chunk);
    }
    svc.symbolsRepo.clearSymbolsForArtifact(resolved.artifactId);
    for (const chunk of chunkArray(rebuilt.symbols, chunkSize)) {
      svc.symbolsRepo.insertSymbolsForArtifact(resolved.artifactId, chunk);
    }
    svc.indexMetaRepo.upsert({
      artifactId: resolved.artifactId,
      artifactSignature: resolved.artifactSignature,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      filesCount: rebuilt.files.length,
      symbolsCount: rebuilt.symbols.length,
      ftsRowsCount: rebuilt.files.length,
      indexedAt: rebuilt.indexedAt,
      indexDurationMs: rebuilt.indexDurationMs
    });
  });
  tx();
  upsertCacheMetrics(svc, resolved.artifactId, rebuilt.totalContentBytes, timestamp);

  log("info", "index.rebuild.done", {
    artifactId: resolved.artifactId,
    reason,
    files: rebuilt.files.length,
    symbols: rebuilt.symbols.length,
    indexDurationMs: rebuilt.indexDurationMs
  });

  return rebuilt;
}

export async function buildRebuiltArtifactData(svc: SourceService, resolved: ResolvedSourceArtifact): Promise<RebuiltArtifactData> {
  const indexStartedAt = Date.now();
  let files: IndexedFileRecord[] = [];
  if (resolved.sourceJarPath) {
    files = await loadFromSourceJar(svc, resolved.sourceJarPath);
  } else if (resolved.binaryJarPath) {
    const decompileInputJarPath = await maybeRemapBinaryForMojang(svc, resolved);
    // When the binary jar was remapped from obfuscated to mojang, swap the resolved
    // artifact's binaryJarPath to the remapped jar so downstream bytecode consumers
    // (getClassMembers, validateMixin) look up mojang names in the mojang jar — not
    // the original obfuscated jar. Persistence in upsertArtifact happens after this
    // function returns, so the swap reaches both the database row and the
    // resolveArtifact response.
    if (decompileInputJarPath !== resolved.binaryJarPath) {
      resolved.binaryJarPath = decompileInputJarPath;
    }
    const vineflowerPath = await resolveVineflowerJar(
      svc.config.cacheDir,
      svc.config.vineflowerJarPath
    );
    const decompileStartedAt = Date.now();
    try {
      const decompileResult = await decompileBinaryJar(decompileInputJarPath, svc.config.cacheDir, {
        vineflowerJarPath: vineflowerPath,
        artifactIdCandidate: resolved.artifactId,
        timeoutMs: 120_000,
        signature: resolved.artifactId
      });
      files = decompileResult.javaFiles.map((entry) => ({
        filePath: normalizePathStyle(entry.filePath),
        content: entry.content,
        contentBytes: Buffer.byteLength(entry.content, "utf8"),
        contentHash: createHash("sha256").update(entry.content).digest("hex")
      }));
    } catch (caughtError) {
      if (isAppError(caughtError) && caughtError.code === ERROR_CODES.DECOMPILER_FAILED) {
        throw createError({
          code: ERROR_CODES.DECOMPILER_FAILED,
          message: caughtError.message,
          details: {
            ...(caughtError.details ?? {}),
            artifactId: resolved.artifactId,
            binaryJarPath: resolved.binaryJarPath,
            producedJavaCount:
              typeof (caughtError.details as Record<string, unknown> | undefined)?.producedJavaCount === "number"
                ? (caughtError.details as Record<string, unknown>).producedJavaCount
                : 0,
            nextAction:
              "Verify Java runtime and Vineflower availability, then retry. If available, prefer source-backed artifacts.",
            recommendedCommand: "echo $MCP_VINEFLOWER_JAR_PATH"
          }
        });
      }
      throw caughtError;
    } finally {
      svc.metrics.recordDuration("decompile_duration_ms", Date.now() - decompileStartedAt);
    }
  } else {
    throw createError({
      code: ERROR_CODES.SOURCE_NOT_FOUND,
      message: "No source artifact available.",
      details: {
        artifactId: resolved.artifactId,
        nextAction: "Use list-artifact-files to inspect the artifact's contents.",
        ...buildSuggestedCall({
          tool: "list-artifact-files",
          params: { artifactId: resolved.artifactId }
        })
      }
    });
  }

  const symbols: RebuiltArtifactData["symbols"] = [];
  for (const file of files) {
    const extracted = extractSymbolsFromSource(file.filePath, file.content);
    for (const symbol of extracted) {
      symbols.push({
        filePath: file.filePath,
        ...symbol
      });
    }
  }

  return {
    files,
    symbols,
    indexedAt: new Date().toISOString(),
    indexDurationMs: Date.now() - indexStartedAt,
    totalContentBytes: files.reduce((sum, file) => sum + file.contentBytes, 0)
  };
}

export function getArtifact(svc: SourceService, artifactId: string): ArtifactRow {
  if (artifactId.includes("..") || artifactId.includes("/")) {
    // intentionally reject suspicious IDs that are not artifact hashes
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "artifactId contains invalid characters.",
      details: { artifactId }
    });
  }
  const artifact = svc.artifactsRepo.getArtifact(artifactId);
  if (!artifact) {
    throw createError({
      code: ERROR_CODES.SOURCE_NOT_FOUND,
      message: "Artifact not found. Resolve context first.",
      details: {
        artifactId,
        nextAction: "Use resolve-artifact to resolve a source artifact first.",
        ...buildSuggestedCall({
          tool: "resolve-artifact",
          params: { target: { kind: "version", value: "latest" } }
        })
      }
    });
  }

  return artifact;
}

export async function ingestIfNeeded(svc: SourceService, resolved: ResolvedSourceArtifact): Promise<void> {
  const existing = svc.artifactsRepo.getArtifact(resolved.artifactId);
  const hasFiles = svc.filesRepo.listFiles(resolved.artifactId, { limit: 1 }).items.length > 0;
  const meta = svc.indexMetaRepo.get(resolved.artifactId);
  const reason = resolveIndexRebuildReason({
    force: false,
    expectedSignature: resolved.artifactSignature,
    hasFiles,
    meta
  });

  if (existing && reason === "already_current") {
    // Mojang binary-remap reconciliation on the warm cache hit path:
    // resolveSourceTargetInternal always returns the original binary jar
    // (resolver does not know about prior remap output), so without this
    // step a warm-cache resolve would return mappingApplied="mojang"
    // alongside binaryJarPath pointing at the obfuscated client jar.
    // maybeRemapBinaryForMojang short-circuits on a healthy cache hit
    // (existsSync + ZIP magic) and re-remaps when the cache is missing
    // or corrupted, so this also recovers from out-of-band cache loss.
    const transformChain = resolved.provenance?.transformChain ?? [];
    if (transformChain.includes("binary-remap:obf->mojang") && resolved.binaryJarPath) {
      const reconciledBinaryJarPath = await maybeRemapBinaryForMojang(svc, resolved);
      if (reconciledBinaryJarPath !== resolved.binaryJarPath) {
        resolved.binaryJarPath = reconciledBinaryJarPath;
      }
    }
    // Backfill / rotate alias on the warm-cache path. Without this, schema-v4
    // migrated rows (alias=NULL) and rows whose alias parameters changed since
    // the last upsert would return an artifactAlias from resolveArtifact that
    // does not resolve back via getArtifact(alias), breaking the 3.1b lookup
    // contract. UNIQUE conflicts here are caller bugs (two distinct artifactIds
    // colliding on alias) and surface as DB errors rather than silent drift.
    if (resolved.artifactAlias && existing.alias !== resolved.artifactAlias) {
      svc.artifactsRepo.setAlias(resolved.artifactId, resolved.artifactAlias);
    }
    svc.metrics.recordArtifactCacheHit();
    const touchedAt = new Date().toISOString();
    svc.artifactsRepo.touchArtifact(resolved.artifactId, touchedAt);
    touchCacheMetrics(svc, resolved.artifactId, touchedAt);
    return;
  }

  svc.metrics.recordArtifactCacheMiss();
  svc.metrics.recordReindex();
  log("info", "index.rebuild.start", {
    artifactId: resolved.artifactId,
    reason
  });

  await rebuildAndPersistArtifactIndex(
    svc,
    resolved,
    reason === "already_current" ? "missing_meta" : reason
  );
  enforceCacheLimits(svc);
}

/**
 * If the resolved artifact's transformChain promised an "obf -> mojang"
 * binary remap, run tiny-remapper now and return the remapped jar path.
 * Otherwise return the original binaryJarPath unchanged.
 *
 * Cache safety: writes to a per-attempt temp file then atomic-renames into
 * <cacheDir>/remapped/<artifactId>.jar. A per-target inflight Promise map
 * collapses concurrent calls so two simultaneous resolveArtifact calls for
 * the same artifactId share one tiny-remapper run instead of racing on the
 * same output path.
 */
export async function maybeRemapBinaryForMojang(svc: SourceService, resolved: ResolvedSourceArtifact): Promise<string> {
  const binaryJarPath = resolved.binaryJarPath;
  if (!binaryJarPath) {
    throw createError({
      code: ERROR_CODES.SOURCE_NOT_FOUND,
      message: "Cannot run binary remap: resolved artifact has no binary jar path.",
      details: { artifactId: resolved.artifactId }
    });
  }
  const transformChain = resolved.provenance?.transformChain ?? [];
  if (!transformChain.includes("binary-remap:obf->mojang")) {
    return binaryJarPath;
  }
  if (!resolved.version) {
    throw createError({
      code: ERROR_CODES.MAPPING_NOT_APPLIED,
      message: "Binary remap promised but artifact has no resolved Minecraft version.",
      details: {
        artifactId: resolved.artifactId,
        binaryJarPath,
        nextAction: "Use target.kind=\"version\" so the remap pipeline can locate Mojang mappings."
      }
    });
  }

  const remappedDir = join(svc.config.cacheDir, "remapped");
  const remappedJarPath = join(remappedDir, `${resolved.artifactId}.jar`);
  if (existsSync(remappedJarPath)) {
    // Validate the cached jar is at least structurally a ZIP (`PK\x03\x04`) and
    // non-empty before reusing. If a prior atomic-rename window was interrupted
    // or the cache file was hand-edited, drop it and re-remap rather than
    // silently feeding a corrupt jar into Vineflower.
    if (await isUsableJarFile(remappedJarPath)) {
      await recordRemappedJarBytesFromDisk(svc, resolved.artifactId, remappedJarPath);
      return remappedJarPath;
    }
    log("warn", "binary-remap.cache.evict-corrupt", {
      artifactId: resolved.artifactId,
      remappedJarPath
    });
    try {
      await unlink(remappedJarPath);
    } catch {
      // ignore: race with another process or already-deleted file.
    }
    releaseRemappedJarBytes(svc, resolved.artifactId);
  }

  const inflight = svc.state.inflightRemaps.get(remappedJarPath);
  if (inflight) {
    return inflight;
  }

  const remapPromise = runBinaryRemap(svc, {
    version: resolved.version,
    inputJar: binaryJarPath,
    remappedDir,
    remappedJarPath
  });
  svc.state.inflightRemaps.set(remappedJarPath, remapPromise);
  try {
    const path = await remapPromise;
    await recordRemappedJarBytesFromDisk(svc, resolved.artifactId, path);
    return path;
  } finally {
    svc.state.inflightRemaps.delete(remappedJarPath);
  }
}

export async function recordRemappedJarBytesFromDisk(svc: SourceService, artifactId: string, path: string): Promise<void> {
  try {
    const fileStat = await stat(path);
    recordRemappedJarBytes(svc, artifactId, fileStat.size);
  } catch {
    // best-effort: accounting will be rebuilt on the next refreshCacheMetrics.
  }
}

/**
 * Best-effort structural check that `path` is a non-empty file beginning with
 * the ZIP local-file-header magic (`50 4B 03 04`). Used to drop partial /
 * corrupt remap-cache entries before they reach Vineflower. False positives
 * are acceptable (Vineflower will surface a clearer error); false negatives
 * are not (a corrupt cache hit must be evicted).
 */
export async function isUsableJarFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size < 4) {
      return false;
    }
  } catch {
    return false;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runBinaryRemap(svc: SourceService, input: {
  version: string;
  inputJar: string;
  remappedDir: string;
  remappedJarPath: string;
}): Promise<string> {
  const tinyRemapperJarPath = await resolveTinyRemapperJar(
    svc.config.cacheDir,
    svc.config.tinyRemapperJarPath
  );
  const mojangTiny = await resolveMojangTinyFile(input.version, svc.config);

  await mkdir(input.remappedDir, { recursive: true });

  const tempPath = `${input.remappedJarPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const remapStartedAt = Date.now();
  try {
    await remapJar(tinyRemapperJarPath, {
      inputJar: input.inputJar,
      outputJar: tempPath,
      mappingsFile: mojangTiny.path,
      fromNamespace: "obfuscated",
      toNamespace: "mojang",
      timeoutMs: svc.config.remapTimeoutMs,
      maxMemoryMb: svc.config.remapMaxMemoryMb
    });
    const tempStats = await stat(tempPath);
    if (tempStats.size === 0) {
      throw createError({
        code: ERROR_CODES.REMAP_FAILED,
        message: "tiny-remapper produced an empty output jar.",
        details: { inputJar: input.inputJar, tempPath }
      });
    }
    await rename(tempPath, input.remappedJarPath);
    return input.remappedJarPath;
  } catch (caughtError) {
    try {
      await unlink(tempPath);
    } catch {
      // tempPath may not exist if remapJar failed before writing anything; ignore.
    }
    throw caughtError;
  } finally {
    svc.metrics.recordDuration("binary_remap_duration_ms", Date.now() - remapStartedAt);
  }
}

export async function loadFromSourceJar(svc: SourceService, sourceJarPath: string): Promise<IndexedFileRecord[]> {
  const files: IndexedFileRecord[] = [];
  for await (const entry of iterateJavaEntriesAsUtf8(sourceJarPath, svc.config.maxContentBytes)) {
  files.push({
      filePath: normalizePathStyle(entry.filePath),
      content: entry.content,
      contentBytes: Buffer.byteLength(entry.content, "utf8"),
      contentHash: createHash("sha256").update(entry.content).digest("hex")
    });
  }

  return files;
}
