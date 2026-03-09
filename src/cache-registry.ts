import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { normalizeOptionalPathForHost, type PathRuntimeInfo } from "./path-converter.js";
import Database from "./storage/sqlite.js";

export const PUBLIC_CACHE_KINDS = [
  "artifact-index",
  "downloads",
  "mapping",
  "registry",
  "decompiled-source",
  "mod-remap"
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

function isCorruptRegistryJson(filePath: string): boolean {
  if (!filePath.endsWith(".json")) {
    return false;
  }
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
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

function openDb(sqlitePath: string): Database | undefined {
  if (!existsSync(sqlitePath)) {
    return undefined;
  }
  return new Database(sqlitePath);
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
  now: number
): CacheHealthState {
  const maybeMeta = entry.meta ?? {};
  if (maybeMeta.inUse === true) {
    return "in_use";
  }
  if (maybeMeta.corrupt === true) {
    return "corrupt";
  }

  const candidatePaths = candidatePathsForEntry(entry);
  const existingPaths = candidatePaths.filter((candidate) => existsSync(candidate));
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
    if (left.cacheKind !== right.cacheKind) {
      return left.cacheKind.localeCompare(right.cacheKind);
    }
    return left.entryId.localeCompare(right.entryId);
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
    if (version !== selector.version && !entry.path.includes(selector.version)) {
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
  return true;
}

async function artifactIndexEntries(config: CacheRegistryConfig): Promise<CacheEntry[]> {
  const db = openDb(config.sqlitePath);
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

async function fileBackedEntries(
  config: CacheRegistryConfig,
  cacheKind: Exclude<PublicCacheKind, "artifact-index">
): Promise<CacheEntry[]> {
  const root = kindRoot(config, cacheKind);
  const files = await listFilesRecursive(root);
  const entries: CacheEntry[] = [];
  for (const filePath of files) {
    const fileStat = await stat(filePath);
    const normalizedEntryId = filePath.slice(root.length + 1);
    const inferredScope = inferScope(filePath, normalizedEntryId) ?? (cacheKind === "decompiled-source" ? "vanilla" : undefined);
    entries.push({
      cacheKind,
      entryId: normalizedEntryId,
      path: filePath,
      sizeBytes: fileStat.size,
      status: "healthy",
      meta: {
        updatedAt: fileStat.mtime.toISOString(),
        version: inferVersion(filePath, normalizedEntryId),
        mapping: inferMapping(filePath, normalizedEntryId),
        scope: inferredScope,
        projectPath: inferProjectPath(filePath, config.pathRuntimeInfo),
        partial: fileStat.size === 0,
        corrupt: cacheKind === "registry" ? isCorruptRegistryJson(filePath) : false,
        inUse:
          filePath.endsWith(".lock") ||
          filePath.endsWith(".wal") ||
          filePath.endsWith(".journal"),
        ...(cacheKind === "downloads" || cacheKind === "mod-remap" ? { jarPath: filePath } : {})
      }
    });
  }
  return entries;
}

export type CacheRegistryConfig = {
  cacheDir: string;
  sqlitePath: string;
  pathRuntimeInfo?: PathRuntimeInfo;
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
  async function collectEntries(
    cacheKinds: PublicCacheKind[] | undefined,
    selector: CacheSelector | undefined
  ): Promise<CacheEntry[]> {
    const selectedKinds = cacheKinds?.length ? cacheKinds : [...PUBLIC_CACHE_KINDS];
    const preparedSelector = prepareSelector(selector, config.pathRuntimeInfo);
    const now = Date.now();
    const entries = await Promise.all(
      selectedKinds.map((cacheKind) =>
        cacheKind === "artifact-index"
          ? artifactIndexEntries(config)
          : fileBackedEntries(config, cacheKind)
      )
    );

    const enriched = entries
      .flat()
      .map((entry) => ({
        ...entry,
        status: deriveEntryStatus(entry, config, now)
      }));

    return sortEntries(enriched.filter((entry) => matchesSelector(entry, preparedSelector, config.pathRuntimeInfo)));
  }

  return {
    async summarize(input) {
      const selectedKinds = input.cacheKinds?.length ? input.cacheKinds : [...PUBLIC_CACHE_KINDS];
      const entries = await collectEntries(selectedKinds, input.selector);
      const kinds: Partial<Record<PublicCacheKind, CacheKindSummary>> = {};

      for (const cacheKind of selectedKinds) {
        const root = kindRoot(config, cacheKind);
        const rows = entries.filter((entry) => entry.cacheKind === cacheKind);
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
      const entries = await collectEntries(input.cacheKinds, input.selector);
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
        const db = openDb(config.sqlitePath);
        try {
          for (const entry of entries) {
            if (entry.cacheKind === "artifact-index") {
              db?.prepare("DELETE FROM artifacts WHERE artifact_id = ?").run([entry.entryId]);
              continue;
            }
            if (existsSync(entry.path)) {
              await rm(entry.path, { force: true });
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
