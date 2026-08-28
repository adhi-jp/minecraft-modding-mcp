import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { mapWithConcurrencyLimit } from "./concurrency.js";
import { createError, ERROR_CODES } from "./errors.js";
import { normalizeOptionalPathForHost, type PathRuntimeInfo } from "./path-converter.js";
import { downloadSidecarPath, isDownloadSidecarPath } from "./repo-downloader.js";
import { openDatabase } from "./storage/db.js";
import type Database from "./storage/sqlite.js";
import {
  getProcessWorkspaceContextCache,
  type WorkspaceContextCache
} from "./workspace-context-cache.js";

export const PUBLIC_CACHE_KINDS = [
  "artifact-index",
  "downloads",
  "mapping",
  "registry",
  "decompiled-source",
  "mod-remap",
  "binary-remap",
  "nested-jar",
  "workspace"
] as const;

export type PublicCacheKind = (typeof PUBLIC_CACHE_KINDS)[number];

export const CACHE_HEALTH_STATES = [
  "healthy",
  "partial",
  "stale",
  "orphaned",
  "corrupt",
  "in_use"
] as const;

export type CacheHealthState = (typeof CACHE_HEALTH_STATES)[number];

export type CacheSelector = {
  artifactId?: string;
  version?: string;
  jarPath?: string;
  entryId?: string;
  status?: CacheHealthState;
  olderThan?: string;
  mapping?: string;
  scope?: string;
  projectPath?: string;
};

export type CacheKindSummary = {
  cacheKind: PublicCacheKind;
  entryCount: number;
  totalBytes: number;
  status: CacheHealthState;
};

export type CacheEntry = {
  cacheKind: PublicCacheKind;
  entryId: string;
  path: string;
  sizeBytes: number;
  status: CacheHealthState;
  owner?: string;
  meta?: Record<string, unknown>;
};

type CacheEntryPage = {
  entries: CacheEntry[];
  nextCursor?: string;
};

type PreparedSelector = CacheSelector & {
  olderThanMs?: number;
  normalizedJarPath?: string;
  normalizedProjectPath?: string;
};

type ArtifactIndexRow = {
  artifact_id: string;
  updated_at: string;
  total_content_bytes: number;
  version: string | null;
  binary_jar_path: string | null;
  source_jar_path: string | null;
  requested_mapping: string | null;
  mapping_applied: string | null;
  quality_flags_json: string | null;
};

const STALE_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CURSOR_VERSION = 1;
const CACHE_STAT_CONCURRENCY = 8;
const STATUS_PRIORITY: CacheHealthState[] = ["in_use", "corrupt", "orphaned", "stale", "partial", "healthy"];

function kindRoot(config: CacheRegistryConfig, cacheKind: PublicCacheKind): string {
  switch (cacheKind) {
    case "artifact-index":
      return resolve(config.sqlitePath);
    case "downloads":
      return join(config.cacheDir, "downloads");
    case "mapping":
      return join(config.cacheDir, "mappings");
    case "registry":
      return join(config.cacheDir, "registries");
    case "decompiled-source":
      return join(config.cacheDir, "decompiled");
    case "mod-remap":
      return join(config.cacheDir, "remapped-mods");
    case "binary-remap":
      return join(config.cacheDir, "remapped");
    case "nested-jar":
      return join(config.cacheDir, "nested-jars");
    case "workspace":
      return "<in-memory:workspace-context-cache>";
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function normalizePathKey(pathValue: string | undefined, runtimeInfo?: PathRuntimeInfo): string | undefined {
  const normalized = normalizeOptionalPathForHost(pathValue, runtimeInfo, "jarPath");
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function inferVersion(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const match = candidate.match(/\b(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)\b/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Whether a cache entry path contains the selector version as a whole version
 * token. Used as a fallback when an entry has no structured meta.version. The
 * match is anchored so that a coarse selector like "1.2" does NOT match a "1.21"
 * path (which would cause destructive prune/delete to hit the wrong caches),
 * while still allowing major.minor sweeps where "1.21" matches "1.21.4".
 */
export function pathContainsVersion(path: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Preceding char must not be a digit or dot (avoid matching inside a longer
  // version like 1.21 -> 21); following char must not be a digit (block
  // 1.2 -> 1.21) but a dot is allowed so 1.21 sweeps 1.21.4.
  return new RegExp(`(?<![\\d.])${escaped}(?!\\d)`).test(path);
}

function inferMapping(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    const normalized = candidate?.toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.includes("intermediary")) {
      return "intermediary";
    }
    if (normalized.includes("mojang")) {
      return "mojang";
    }
    if (normalized.includes("yarn")) {
      return "yarn";
    }
    if (normalized.includes("obfuscated")) {
      return "obfuscated";
    }
  }
  return undefined;
}

function inferScope(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    const normalized = candidate?.toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.includes("loader")) {
      return "loader";
    }
    if (normalized.includes("merged")) {
      return "merged";
    }
    if (normalized.includes("vanilla")) {
      return "vanilla";
    }
  }
  return undefined;
}

function inferProjectPath(pathValue: string | undefined, runtimeInfo?: PathRuntimeInfo): string | undefined {
  const normalized = normalizePathKey(pathValue, runtimeInfo);
  if (!normalized) {
    return undefined;
  }
  for (const marker of ["/.gradle/", "/build/", "/src/"]) {
    const index = normalized.indexOf(marker);
    if (index > 0) {
      return normalized.slice(0, index);
    }
  }
  return undefined;
}

async function isCorruptRegistryJson(filePath: string): Promise<boolean> {
  if (!filePath.endsWith(".json")) {
    return false;
  }
  try {
    JSON.parse(await readFile(filePath, "utf8"));
    return false;
  } catch {
    return true;
  }
}

function parseOlderThan(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `olderThan must be an ISO-8601 duration like "P30D" or "PT12H".`
    });
  }
  const weeks = Number(match[1] ?? 0);
  const days = Number(match[2] ?? 0);
  const hours = Number(match[3] ?? 0);
  const minutes = Number(match[4] ?? 0);
  const seconds = Number(match[5] ?? 0);
  const totalMs =
    (((weeks * 7 + days) * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
  if (totalMs <= 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "olderThan must be greater than zero."
    });
  }
  return totalMs;
}

function prepareSelector(selector: CacheSelector | undefined, runtimeInfo?: PathRuntimeInfo): PreparedSelector | undefined {
  if (!selector) {
    return undefined;
  }
  return {
    ...selector,
    olderThanMs: parseOlderThan(selector.olderThan),
    normalizedJarPath: normalizePathKey(selector.jarPath, runtimeInfo),
    normalizedProjectPath: normalizePathKey(selector.projectPath, runtimeInfo)
  };
}

function openDb(config: CacheRegistryConfig): Database | undefined {
  if (!existsSync(config.sqlitePath)) {
    return undefined;
  }
  return openDatabase(config).db;
}

function candidatePathsForEntry(entry: CacheEntry): string[] {
  const paths = new Set<string>();
  const maybeMeta = entry.meta ?? {};
  for (const candidate of [
    entry.path,
    typeof maybeMeta.jarPath === "string" ? maybeMeta.jarPath : undefined,
    typeof maybeMeta.binaryJarPath === "string" ? maybeMeta.binaryJarPath : undefined,
    typeof maybeMeta.sourceJarPath === "string" ? maybeMeta.sourceJarPath : undefined,
    typeof maybeMeta.projectPath === "string" ? maybeMeta.projectPath : undefined
  ]) {
    if (candidate) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

function entryUpdatedAt(entry: CacheEntry): string | undefined {
  return typeof entry.meta?.updatedAt === "string" ? entry.meta.updatedAt as string : undefined;
}

function deriveEntryStatus(
  entry: CacheEntry,
  config: CacheRegistryConfig,
  now: number,
  entryPathExists = false
): CacheHealthState {
  const maybeMeta = entry.meta ?? {};
  if (maybeMeta.inUse === true) {
    return "in_use";
  }
  if (maybeMeta.corrupt === true) {
    return "corrupt";
  }

  const candidatePaths = candidatePathsForEntry(entry);
  const existingPaths = candidatePaths.filter(
    (candidate) => (entryPathExists && candidate === entry.path) || existsSync(candidate)
  );
  if (entry.cacheKind === "artifact-index" && !existsSync(config.sqlitePath)) {
    return "orphaned";
  }
  if (candidatePaths.length > 0 && existingPaths.length === 0) {
    return "orphaned";
  }
  if (candidatePaths.length > 1 && existingPaths.length > 0 && existingPaths.length < candidatePaths.length) {
    return "partial";
  }
  if (maybeMeta.partial === true) {
    return "partial";
  }

  const updatedAt = entryUpdatedAt(entry);
  if (updatedAt) {
    const updatedAtMs = Date.parse(updatedAt);
    if (Number.isFinite(updatedAtMs) && now - updatedAtMs >= STALE_ENTRY_AGE_MS) {
      return "stale";
    }
  }

  return "healthy";
}

function sortEntries(entries: CacheEntry[]): CacheEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = entrySortKey(left);
    const rightKey = entrySortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function entrySortKey(entry: CacheEntry): string {
  return `${entry.cacheKind}\u0000${entry.entryId}`;
}

function encodeCursor(entry: CacheEntry): string {
  return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, key: entrySortKey(entry) }), "utf8").toString("base64");
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { version?: number; key?: string };
    if (decoded.version !== CURSOR_VERSION || typeof decoded.key !== "string" || !decoded.key) {
      throw new Error("invalid");
    }
    return decoded.key;
  } catch {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Invalid pagination cursor."
    });
  }
}

function paginateEntries(entries: CacheEntry[], limit: number, cursor: string | undefined): CacheEntryPage {
  const cursorKey = decodeCursor(cursor);
  const pageSource = cursorKey
    ? entries.filter((entry) => entrySortKey(entry) > cursorKey)
    : entries;
  const pageEntries = pageSource.slice(0, limit);
  return {
    entries: pageEntries,
    nextCursor: pageSource.length > limit && pageEntries.length > 0 ? encodeCursor(pageEntries[pageEntries.length - 1]!) : undefined
  };
}

function rollupStatus(entries: CacheEntry[], rootExists: boolean): CacheHealthState {
  if (!rootExists || entries.length === 0) {
    return "partial";
  }
  for (const status of STATUS_PRIORITY) {
    if (entries.some((entry) => entry.status === status)) {
      return status;
    }
  }
  return "healthy";
}

function matchesSelector(entry: CacheEntry, selector: PreparedSelector | undefined, runtimeInfo?: PathRuntimeInfo): boolean {
  if (!selector) {
    return true;
  }
  const maybeMeta = entry.meta ?? {};
  if (selector.entryId && selector.entryId !== entry.entryId) {
    return false;
  }
  if (selector.artifactId && maybeMeta.artifactId !== selector.artifactId) {
    return false;
  }
  if (selector.status && selector.status !== entry.status) {
    return false;
  }
  if (selector.version) {
    const version = typeof maybeMeta.version === "string" ? maybeMeta.version : undefined;
    if (version !== selector.version && !pathContainsVersion(entry.path, selector.version)) {
      return false;
    }
  }
  if (selector.mapping) {
    const mappings = new Set(
      [maybeMeta.mapping, maybeMeta.requestedMapping, maybeMeta.mappingApplied]
        .filter((value): value is string => typeof value === "string")
    );
    if (!mappings.has(selector.mapping)) {
      return false;
    }
  }
  if (selector.scope) {
    const scope = typeof maybeMeta.scope === "string" ? maybeMeta.scope : undefined;
    if (scope !== selector.scope) {
      return false;
    }
  }
  if (selector.olderThanMs != null) {
    const updatedAt = entryUpdatedAt(entry);
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs < selector.olderThanMs) {
      return false;
    }
  }
  if (selector.normalizedJarPath || selector.normalizedProjectPath) {
    const normalizedPaths = candidatePathsForEntry(entry)
      .map((candidate) => normalizePathKey(candidate, runtimeInfo))
      .filter((candidate): candidate is string => Boolean(candidate));
    if (selector.normalizedJarPath && !normalizedPaths.includes(selector.normalizedJarPath)) {
      return false;
    }
    if (selector.normalizedProjectPath) {
      const projectMatch = normalizedPaths.some((candidate) =>
        candidate === selector.normalizedProjectPath || candidate.startsWith(`${selector.normalizedProjectPath}/`)
      );
      if (!projectMatch) {
        return false;
      }
    }
  }
  return true;
}

async function artifactIndexEntries(config: CacheRegistryConfig): Promise<CacheEntry[]> {
  const db = openDb(config);
  if (!db) {
    return [];
  }

  try {
    const rows = db.prepare<ArtifactIndexRow>(`
      SELECT
        artifacts.artifact_id,
        artifacts.updated_at,
        COALESCE(artifact_content_bytes.total_content_bytes, 0) AS total_content_bytes,
        artifacts.version,
        artifacts.binary_jar_path,
        artifacts.source_jar_path,
        artifacts.requested_mapping,
        artifacts.mapping_applied,
        artifacts.quality_flags_json
      FROM artifacts
      LEFT JOIN artifact_content_bytes
        ON artifact_content_bytes.artifact_id = artifacts.artifact_id
      ORDER BY artifacts.updated_at DESC
    `).all();

    const dbInUse = existsSync(`${config.sqlitePath}-wal`) || existsSync(`${config.sqlitePath}-journal`);
    return rows.map((row) => {
      const qualityFlags = parseStringArray(row.quality_flags_json);
      const binaryJarPath = row.binary_jar_path ?? undefined;
      const sourceJarPath = row.source_jar_path ?? undefined;
      return {
        cacheKind: "artifact-index",
        entryId: row.artifact_id,
        path: binaryJarPath ?? sourceJarPath ?? config.sqlitePath,
        sizeBytes: Math.max(0, row.total_content_bytes),
        status: "healthy",
        meta: {
          artifactId: row.artifact_id,
          updatedAt: row.updated_at,
          version: row.version ?? inferVersion(binaryJarPath, sourceJarPath),
          requestedMapping: row.requested_mapping ?? undefined,
          mappingApplied: row.mapping_applied ?? undefined,
          mapping: row.mapping_applied ?? row.requested_mapping ?? inferMapping(binaryJarPath, sourceJarPath, ...qualityFlags),
          binaryJarPath,
          sourceJarPath,
          projectPath: inferProjectPath(binaryJarPath ?? sourceJarPath, config.pathRuntimeInfo),
          scope: inferScope(binaryJarPath, sourceJarPath, ...qualityFlags) ?? "vanilla",
          partial: qualityFlags.some((flag) => flag.includes("partial")),
          inUse: dbInUse
        }
      };
    });
  } finally {
    db.close();
  }
}

function workspaceCacheEntries(workspaceCache: WorkspaceContextCache): CacheEntry[] {
  const contexts = workspaceCache.list();
  return contexts.map((ctx) => ({
    cacheKind: "workspace" as const,
    entryId: ctx.projectPath,
    path: ctx.projectPath,
    sizeBytes: 0,
    status: "healthy" as const,
    meta: {
      projectPath: ctx.projectPath,
      minecraftVersion: ctx.minecraftVersion,
      compileMapping: ctx.compileMapping,
      loader: ctx.loader,
      detectedAt: new Date(ctx.detectedAt).toISOString(),
      updatedAt: new Date(ctx.detectedAt).toISOString(),
      partial: ctx.partial === true,
      dependencyVersionCount: ctx.dependencyVersions.size
    }
  }));
}

async function fileBackedEntries(
  config: CacheRegistryConfig,
  cacheKind: Exclude<PublicCacheKind, "artifact-index" | "workspace">,
  detectCorruption: boolean
): Promise<CacheEntry[]> {
  if (cacheKind === "binary-remap") {
    return binaryRemapEntries(config);
  }

  const root = kindRoot(config, cacheKind);
  const files = await listFilesRecursive(root);
  // A download sidecar (`<jar>.cache.json`, or the `.<hex>.tmp` leftover of an
  // interrupted write) is the identity record of the jar beside it, not a cached
  // artifact in its own right. Listing one would report a `downloads` entry whose
  // jarPath is a JSON file and would let a jarPath selector delete a description
  // instead of the thing described. The finished record's bytes are folded into
  // the jar's entry below, so a listed entry weighs everything that belongs to
  // it; bytes that describe nothing - an orphan record, a half-written one - are
  // deliberately unaccounted, because there is no entry for them to belong to.
  // Only this kind names files that way; every other kind keeps every file.
  const entryFiles = cacheKind === "downloads"
    ? files.filter((filePath) => !isDownloadSidecarPath(filePath))
    : files;
  return mapWithConcurrencyLimit(entryFiles, CACHE_STAT_CONCURRENCY, async (filePath): Promise<CacheEntry> => {
    const fileStat = await stat(filePath);
    const sidecarBytes = cacheKind === "downloads" ? await downloadSidecarSizeBytes(filePath) : 0;
    const normalizedEntryId = filePath.slice(root.length + 1);
    const inferredScope = inferScope(filePath, normalizedEntryId) ?? (cacheKind === "decompiled-source" ? "vanilla" : undefined);
    return {
      cacheKind,
      entryId: normalizedEntryId,
      path: filePath,
      sizeBytes: fileStat.size + sidecarBytes,
      status: "healthy",
      meta: {
        updatedAt: fileStat.mtime.toISOString(),
        version: inferVersion(filePath, normalizedEntryId),
        mapping: inferMapping(filePath, normalizedEntryId),
        scope: inferredScope,
        projectPath: inferProjectPath(filePath, config.pathRuntimeInfo),
        // Health follows the cached artifact's own bytes: a zero-byte jar stays
        // partial no matter how much its sidecar weighs.
        partial: fileStat.size === 0,
        corrupt: cacheKind === "registry" && detectCorruption ? await isCorruptRegistryJson(filePath) : false,
        inUse:
          filePath.endsWith(".lock") ||
          filePath.endsWith(".wal") ||
          filePath.endsWith(".journal"),
        ...(cacheKind === "downloads" || cacheKind === "mod-remap"
          ? { jarPath: filePath }
          : {})
      }
    };
  });
}

/**
 * Bytes of the sidecar describing `downloadPath`, or 0 when there is none.
 * A download cached before sidecars existed, or one whose sidecar write failed,
 * is a normal state and must not fail the inventory.
 */
async function downloadSidecarSizeBytes(downloadPath: string): Promise<number> {
  try {
    return (await stat(downloadSidecarPath(downloadPath))).size;
  } catch {
    return 0;
  }
}

/**
 * Binary-remap cache entries are keyed by the final artifact id even when the
 * on-disk entry is a corrupt final directory or a leftover temp path.
 */
function parseBinaryRemapEntryName(name: string): { artifactId: string; corrupt: boolean } | undefined {
  const legacyTempMatch = /^(.+)\.jar\.tmp\..+$/.exec(name);
  if (legacyTempMatch?.[1]) {
    return { artifactId: legacyTempMatch[1], corrupt: true };
  }

  const tempMatch = /^(.+)\.tmp\.\d+\.\d+\.[A-Za-z0-9_-]+\.jar$/.exec(name);
  if (tempMatch?.[1]) {
    return { artifactId: tempMatch[1], corrupt: true };
  }

  const finalJarMatch = /^(.+)\.jar$/.exec(name);
  if (finalJarMatch?.[1]) {
    return { artifactId: finalJarMatch[1], corrupt: false };
  }

  return undefined;
}

async function binaryRemapEntries(config: CacheRegistryConfig): Promise<CacheEntry[]> {
  const root = kindRoot(config, "binary-remap");
  if (!existsSync(root)) {
    return [];
  }

  const entries: CacheEntry[] = [];
  // Do not recurse here: a corrupt `<artifactId>.jar` directory must remain one
  // selectable cache entry so `selector.artifactId` can remove it recursively.
  const dirents = await readdir(root, { withFileTypes: true });
  for (const entry of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() && !entry.isDirectory()) {
      continue;
    }
    const parsed = parseBinaryRemapEntryName(entry.name);
    if (!parsed) {
      continue;
    }

    const filePath = join(root, entry.name);
    const fileStat = await stat(filePath);
    const corrupt = parsed.corrupt || entry.isDirectory();
    const sizeBytes = entry.isDirectory()
      ? await directoryFileSizeBytes(filePath)
      : fileStat.size;
    entries.push({
      cacheKind: "binary-remap",
      entryId: entry.name,
      path: filePath,
      sizeBytes,
      status: corrupt ? "corrupt" : "healthy",
      meta: {
        updatedAt: fileStat.mtime.toISOString(),
        version: inferVersion(filePath, entry.name),
        mapping: inferMapping(filePath, entry.name),
        scope: inferScope(filePath, entry.name),
        projectPath: inferProjectPath(filePath, config.pathRuntimeInfo),
        partial: entry.isFile() && fileStat.size === 0,
        corrupt,
        inUse: false,
        jarPath: filePath,
        artifactId: parsed.artifactId
      }
    });
  }
  return entries;
}

async function directoryFileSizeBytes(root: string): Promise<number> {
  const files = await listFilesRecursive(root);
  let totalBytes = 0;
  for (const filePath of files) {
    try {
      totalBytes += (await stat(filePath)).size;
    } catch {
      // The entry may disappear during cleanup or a concurrent cache write.
    }
  }
  return totalBytes;
}

export type CacheRegistryConfig = {
  cacheDir: string;
  sqlitePath: string;
  pathRuntimeInfo?: PathRuntimeInfo;
  workspaceContextCache?: WorkspaceContextCache;
};

export interface CacheRegistry {
  summarize(input: { cacheKinds?: PublicCacheKind[]; selector?: CacheSelector }): Promise<{
    kinds: Partial<Record<PublicCacheKind, CacheKindSummary>>;
  }>;
  listEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
    limit?: number;
    cursor?: string;
  }): Promise<CacheEntryPage>;
  inspectEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
    limit?: number;
  }): Promise<CacheEntry[]>;
  verifyEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
  }): Promise<{ checkedEntries: number; unhealthyEntries: number; warnings: string[] }>;
  deleteEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
    executionMode: "preview" | "apply";
  }): Promise<{ deletedEntries: number; deletedBytes: number; warnings: string[] }>;
  pruneEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
    executionMode: "preview" | "apply";
  }): Promise<{ deletedEntries: number; deletedBytes: number; warnings: string[] }>;
  rebuildEntries(input: {
    cacheKinds?: PublicCacheKind[];
    selector?: CacheSelector;
    executionMode: "preview" | "apply";
  }): Promise<{ rebuiltEntries: number; warnings: string[] }>;
}

export function createCacheRegistry(config: CacheRegistryConfig): CacheRegistry {
  const workspaceCache = config.workspaceContextCache ?? getProcessWorkspaceContextCache();

  async function collectEntries(
    cacheKinds: PublicCacheKind[] | undefined,
    selector: CacheSelector | undefined,
    detectCorruption = false
  ): Promise<CacheEntry[]> {
    const selectedKinds = cacheKinds?.length ? cacheKinds : [...PUBLIC_CACHE_KINDS];
    const preparedSelector = prepareSelector(selector, config.pathRuntimeInfo);
    const detectCorruptionForKinds = detectCorruption || selector?.status === "corrupt";
    const now = Date.now();
    const entries = await Promise.all(
      selectedKinds.map((cacheKind) => {
        if (cacheKind === "artifact-index") {
          return artifactIndexEntries(config);
        }
        if (cacheKind === "workspace") {
          return Promise.resolve(workspaceCacheEntries(workspaceCache));
        }
        return fileBackedEntries(config, cacheKind, detectCorruptionForKinds);
      })
    );

    const enriched = entries
      .flat()
      .map((entry) => ({
        ...entry,
        status: entry.cacheKind === "workspace"
          ? entry.status
          : deriveEntryStatus(entry, config, now, entry.cacheKind !== "artifact-index")
      }));

    return sortEntries(enriched.filter((entry) => matchesSelector(entry, preparedSelector, config.pathRuntimeInfo)));
  }

  return {
    async summarize(input) {
      const selectedKinds = input.cacheKinds?.length ? input.cacheKinds : [...PUBLIC_CACHE_KINDS];
      const entries = await collectEntries(selectedKinds, input.selector);
      const kinds: Partial<Record<PublicCacheKind, CacheKindSummary>> = {};

      for (const cacheKind of selectedKinds) {
        const rows = entries.filter((entry) => entry.cacheKind === cacheKind);
        if (cacheKind === "workspace") {
          kinds[cacheKind] = {
            cacheKind,
            entryCount: rows.length,
            totalBytes: 0,
            status: "healthy"
          };
          continue;
        }
        const root = kindRoot(config, cacheKind);
        kinds[cacheKind] = {
          cacheKind,
          entryCount: rows.length,
          totalBytes: rows.reduce((total, entry) => total + entry.sizeBytes, 0),
          status: rollupStatus(rows, existsSync(root))
        };
      }

      return { kinds };
    },

    async listEntries(input) {
      const entries = await collectEntries(input.cacheKinds, input.selector);
      const limit = Math.max(1, input.limit ?? 50);
      return paginateEntries(entries, limit, input.cursor);
    },

    async inspectEntries(input) {
      const entries = await collectEntries(input.cacheKinds, input.selector);
      const limit = Math.max(1, input.limit ?? 50);
      return entries.slice(0, limit);
    },

    async verifyEntries(input) {
      const entries = await collectEntries(input.cacheKinds, input.selector, true);
      const unhealthy = entries.filter((entry) => entry.status !== "healthy");
      const warningStatuses = [...new Set(unhealthy.map((entry) => entry.status))];
      return {
        checkedEntries: entries.length,
        unhealthyEntries: unhealthy.length,
        warnings: warningStatuses.length > 0
          ? [`Detected cache entries with health states: ${warningStatuses.join(", ")}.`]
          : []
      };
    },

    async deleteEntries(input) {
      const entries = await collectEntries(input.cacheKinds, input.selector);
      const selectedBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);

      if (input.executionMode === "apply") {
        const db = openDb(config);
        try {
          for (const entry of entries) {
            if (entry.cacheKind === "artifact-index") {
              db?.prepare("DELETE FROM artifacts WHERE artifact_id = ?").run([entry.entryId]);
              continue;
            }
            if (entry.cacheKind === "workspace") {
              workspaceCache.invalidate(entry.entryId);
              continue;
            }
            if (entry.cacheKind === "downloads") {
              // The sidecar is part of this entry, so it goes with the jar —
              // outside the existsSync guard below, so a jar that vanished
              // out-of-band since the listing still takes its sidecar with it
              // instead of leaving an orphan behind. `force` makes a missing
              // sidecar a no-op.
              await rm(downloadSidecarPath(entry.path), { force: true });
            }
            if (existsSync(entry.path)) {
              // Only binary-remap inventory can return directories as entries;
              // other file-backed kinds keep their existing file-only contract.
              await rm(entry.path, { recursive: entry.cacheKind === "binary-remap", force: true });
            }
          }
        } finally {
          db?.close();
        }
      }

      return {
        deletedEntries: entries.length,
        deletedBytes: selectedBytes,
        warnings: []
      };
    },

    async pruneEntries(input) {
      return this.deleteEntries(input);
    },

    async rebuildEntries(input) {
      const entries = await collectEntries(input.cacheKinds, input.selector);
      return {
        rebuiltEntries: entries.length,
        warnings: []
      };
    }
  };
}
