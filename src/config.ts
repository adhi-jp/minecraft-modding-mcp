import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "./types.js";
import { normalizePathForHost } from "./path-converter.js";

const DEFAULTS = {
  cacheDir: "~/.cache/minecraft-modding-mcp",
  sourceRepos: [
    "https://repo1.maven.org/maven2",
    "https://maven.fabricmc.net",
    "https://maven.minecraftforge.net",
    "https://maven.neoforged.net/releases"
  ],
  localM2Path: "~/.m2/repository",
  indexedSearchEnabled: true,
  mappingSourcePriority: "loom-first",
  maxContentBytes: 1_000_000,
  maxSearchHits: 200,
  maxArtifacts: 200,
  maxCacheBytes: 2_147_483_648,
  fetchTimeoutMs: 15000,
  fetchRetries: 2,
  searchScanPageSize: 250,
  indexInsertChunkSize: 200,
  maxMappingGraphCache: 16,
  maxSignatureCache: 2_000,
  maxVersionDetailCache: 256,
  maxNbtInputBytes: 4 * 1024 * 1024,
  maxNbtInflatedBytes: 16 * 1024 * 1024,
  maxNbtResponseBytes: 8 * 1024 * 1024,
  remapTimeoutMs: 600_000,
  remapMaxMemoryMb: 4096
} as const;

const MAX_RETRIES_LOWER_BOUND = 0;
const MAX_RETRIES_UPPER_BOUND = 20;
const MAX_BYTES_LOWER_BOUND = 1;
const MAX_SEARCH_HITS_LOWER_BOUND = 1;
const MAX_SEARCH_HITS_UPPER_BOUND = 10_000;
const MAX_ARTIFACTS_LOWER_BOUND = 1;
const MAX_ARTIFACTS_UPPER_BOUND = 100_000;
const MAX_CACHE_BYTES_LOWER_BOUND = 1_024;
const TIMEOUT_LOWER_BOUND_MS = 500;
const SEARCH_SCAN_PAGE_SIZE_LOWER_BOUND = 1;
const SEARCH_SCAN_PAGE_SIZE_UPPER_BOUND = 10_000;
const INDEX_INSERT_CHUNK_SIZE_LOWER_BOUND = 1;
const INDEX_INSERT_CHUNK_SIZE_UPPER_BOUND = 20_000;
const CACHE_ENTRIES_LOWER_BOUND = 1;
const CACHE_ENTRIES_UPPER_BOUND = 100_000;

function expandHome(pathValue: string): string {
  if (!pathValue.startsWith("~")) {
    return pathValue;
  }

  const withoutTilde = pathValue.startsWith("~/") ? pathValue.slice(2) : pathValue.slice(1);
  return resolve(homedir(), withoutTilde);
}

function normalizeOptionalPathEnvValue(pathValue: string | undefined): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  const trimmed = pathValue.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  return normalized === "undefined" || normalized === "null" ? undefined : trimmed;
}

function normalizePath(pathValue: string, field: string): string {
  const expanded = expandHome(pathValue.trim());
  const normalizedForHost = normalizePathForHost(expanded, undefined, field);
  if (isAbsolute(normalizedForHost)) {
    return normalizedForHost;
  }
  return resolve(process.cwd(), normalizedForHost);
}

function parseNumber(
  envValue: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!envValue) {
    return fallback;
  }

  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function parseRepos(envValue: string | undefined): string[] {
  const entries = (envValue ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    return [...DEFAULTS.sourceRepos];
  }

  const validated: string[] = [];
  for (const entry of entries) {
    const parsed = parseRepoUrl(entry);
    if (parsed) {
      validated.push(parsed);
    }
  }

  return validated.length > 0 ? validated : [...DEFAULTS.sourceRepos];
}

function parseBoolean(envValue: string | undefined, fallback: boolean): boolean {
  if (!envValue) {
    return fallback;
  }

  const normalized = envValue.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return fallback;
}

function parseRepoUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function parseMappingSourcePriority(
  envValue: string | undefined
): Config["mappingSourcePriority"] {
  const normalized = envValue?.trim().toLowerCase();
  if (normalized === "maven-first") {
    return "maven-first";
  }
  if (normalized === "loom-first") {
    return "loom-first";
  }
  return DEFAULTS.mappingSourcePriority;
}

function parseOptionalJarPath(envValue: string | undefined, field: string): string | undefined {
  const trimmed = normalizeOptionalPathEnvValue(envValue);
  return trimmed ? normalizePath(trimmed, field) : undefined;
}

function parseRequiredPath(envValue: string | undefined, fallback: string, field: string): string {
  return normalizePath(normalizeOptionalPathEnvValue(envValue) ?? fallback, field);
}

function parseVineflowerPath(envValue: string | undefined): string | undefined {
  return parseOptionalJarPath(envValue, "MCP_VINEFLOWER_JAR_PATH");
}

function buildArtifactsDirectory(cacheDir: string): string {
  const input = `${cacheDir}/source-cache.db`;
  return normalizePath(input, "MCP_SQLITE_PATH");
}

export function loadConfig(): Config {
  const cacheDir = parseRequiredPath(process.env.MCP_CACHE_DIR, DEFAULTS.cacheDir, "MCP_CACHE_DIR");
  const localM2Path = parseRequiredPath(process.env.MCP_LOCAL_M2, DEFAULTS.localM2Path, "MCP_LOCAL_M2");

  const sourceRepos = parseRepos(process.env.MCP_SOURCE_REPOS);

  return {
    cacheDir,
    sqlitePath: parseRequiredPath(
      process.env.MCP_SQLITE_PATH,
      buildArtifactsDirectory(cacheDir),
      "MCP_SQLITE_PATH"
    ),
    sourceRepos,
    localM2Path,
    vineflowerJarPath: parseVineflowerPath(process.env.MCP_VINEFLOWER_JAR_PATH),
    indexedSearchEnabled: parseBoolean(
      process.env.MCP_ENABLE_INDEXED_SEARCH,
      DEFAULTS.indexedSearchEnabled
    ),
    mappingSourcePriority: parseMappingSourcePriority(process.env.MCP_MAPPING_SOURCE_PRIORITY),
    maxContentBytes: parseNumber(
      process.env.MCP_MAX_CONTENT_BYTES,
      DEFAULTS.maxContentBytes,
      MAX_BYTES_LOWER_BOUND,
      Number.MAX_SAFE_INTEGER
    ),
    maxSearchHits: parseNumber(
      process.env.MCP_MAX_SEARCH_HITS,
      DEFAULTS.maxSearchHits,
      MAX_SEARCH_HITS_LOWER_BOUND,
      MAX_SEARCH_HITS_UPPER_BOUND
    ),
    maxArtifacts: parseNumber(
      process.env.MCP_MAX_ARTIFACTS,
      DEFAULTS.maxArtifacts,
      MAX_ARTIFACTS_LOWER_BOUND,
      MAX_ARTIFACTS_UPPER_BOUND
    ),
    maxCacheBytes: parseNumber(
      process.env.MCP_MAX_CACHE_BYTES,
      DEFAULTS.maxCacheBytes,
      MAX_CACHE_BYTES_LOWER_BOUND,
      Number.MAX_SAFE_INTEGER
    ),
    fetchTimeoutMs: parseNumber(
      process.env.MCP_FETCH_TIMEOUT_MS,
      DEFAULTS.fetchTimeoutMs,
      TIMEOUT_LOWER_BOUND_MS,
      Number.MAX_SAFE_INTEGER
    ),
    fetchRetries: parseNumber(
      process.env.MCP_FETCH_RETRIES,
      DEFAULTS.fetchRetries,
      MAX_RETRIES_LOWER_BOUND,
      MAX_RETRIES_UPPER_BOUND
    ),
    searchScanPageSize: parseNumber(
      process.env.MCP_SEARCH_SCAN_PAGE_SIZE,
      DEFAULTS.searchScanPageSize,
      SEARCH_SCAN_PAGE_SIZE_LOWER_BOUND,
      SEARCH_SCAN_PAGE_SIZE_UPPER_BOUND
    ),
    indexInsertChunkSize: parseNumber(
      process.env.MCP_INDEX_INSERT_CHUNK_SIZE,
      DEFAULTS.indexInsertChunkSize,
      INDEX_INSERT_CHUNK_SIZE_LOWER_BOUND,
      INDEX_INSERT_CHUNK_SIZE_UPPER_BOUND
    ),
    maxMappingGraphCache: parseNumber(
      process.env.MCP_CACHE_GRAPH_MAX,
      DEFAULTS.maxMappingGraphCache,
      CACHE_ENTRIES_LOWER_BOUND,
      CACHE_ENTRIES_UPPER_BOUND
    ),
    maxSignatureCache: parseNumber(
      process.env.MCP_CACHE_SIGNATURE_MAX,
      DEFAULTS.maxSignatureCache,
      CACHE_ENTRIES_LOWER_BOUND,
      CACHE_ENTRIES_UPPER_BOUND
    ),
    maxVersionDetailCache: parseNumber(
      process.env.MCP_CACHE_VERSION_DETAIL_MAX,
      DEFAULTS.maxVersionDetailCache,
      CACHE_ENTRIES_LOWER_BOUND,
      CACHE_ENTRIES_UPPER_BOUND
    ),
    maxNbtInputBytes: parseNumber(
      process.env.MCP_MAX_NBT_INPUT_BYTES,
      DEFAULTS.maxNbtInputBytes,
      MAX_BYTES_LOWER_BOUND,
      Number.MAX_SAFE_INTEGER
    ),
    maxNbtInflatedBytes: parseNumber(
      process.env.MCP_MAX_NBT_INFLATED_BYTES,
      DEFAULTS.maxNbtInflatedBytes,
      MAX_BYTES_LOWER_BOUND,
      Number.MAX_SAFE_INTEGER
    ),
    maxNbtResponseBytes: parseNumber(
      process.env.MCP_MAX_NBT_RESPONSE_BYTES,
      DEFAULTS.maxNbtResponseBytes,
      MAX_BYTES_LOWER_BOUND,
      Number.MAX_SAFE_INTEGER
    ),
    tinyRemapperJarPath: parseOptionalJarPath(
      process.env.MCP_TINY_REMAPPER_JAR_PATH,
      "MCP_TINY_REMAPPER_JAR_PATH"
    ),
    remapTimeoutMs: parseNumber(
      process.env.MCP_REMAP_TIMEOUT_MS,
      DEFAULTS.remapTimeoutMs,
      TIMEOUT_LOWER_BOUND_MS,
      Number.MAX_SAFE_INTEGER
    ),
    remapMaxMemoryMb: parseNumber(
      process.env.MCP_REMAP_MAX_MEMORY_MB,
      DEFAULTS.remapMaxMemoryMb,
      64,
      Number.MAX_SAFE_INTEGER
    )
  };
}

export function stableArtifactId(parts: string[]): string {
  const normalizer = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("|");
  return createHash("sha256").update(normalizer).digest("hex");
}

export { DEFAULTS };
