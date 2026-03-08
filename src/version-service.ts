import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { computeFileSha1 } from "./hash.js";
import { defaultDownloadPath, downloadToCache } from "./repo-downloader.js";
import type { Config } from "./types.js";

const DEFAULT_VERSION_MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MANIFEST_CACHE_TTL_MS = 60 * 60 * 1000;
const VERSION_DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;

interface VersionManifestEntry {
  id: string;
  type: string;
  url: string;
  time?: string;
  releaseTime?: string;
}

interface VersionManifest {
  latest?: {
    release?: string;
    snapshot?: string;
  };
  versions?: VersionManifestEntry[];
}

interface VersionDownloadRecord {
  url?: string;
  sha1?: string;
  size?: number;
}

interface VersionDetails {
  id?: string;
  downloads?: {
    client?: VersionDownloadRecord;
    client_mappings?: VersionDownloadRecord;
    server_mappings?: VersionDownloadRecord;
    server?: VersionDownloadRecord;
  };
}

type VersionCacheEntry = {
  version: string;
  jarPath: string;
  downloadedAt: string;
};

type VersionCacheIndex = {
  entries: VersionCacheEntry[];
};

export type ListVersionsInput = {
  includeSnapshots?: boolean;
  limit?: number;
};

export type VersionEntry = {
  id: string;
  unobfuscated: boolean;
};

export type ListVersionsOutput = {
  latest: {
    release?: string;
    snapshot?: string;
  };
  releases: VersionEntry[];
  snapshots?: VersionEntry[];
  cached: string[];
  totalAvailable: number;
};

export type ResolvedVersionJar = {
  version: string;
  jarPath: string;
  source: "downloaded";
  clientJarUrl: string;
};

export type ResolvedServerJar = {
  version: string;
  jarPath: string;
  source: "downloaded";
  serverJarUrl: string;
};

export type ResolvedVersionMappings = {
  version: string;
  versionManifestUrl: string;
  versionDetailUrl: string;
  clientMappingsUrl?: string;
  serverMappingsUrl?: string;
  mappingsUrl?: string;
};

export type ListVersionIdsInput = {
  includeSnapshots?: boolean;
};

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function isVersionManifest(value: unknown): value is VersionManifest {
  return typeof value === "object" && value !== null;
}

function ensureVersionDetail(value: unknown, version: string): VersionDetails {
  if (typeof value !== "object" || value == null) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `Version metadata for "${version}" is invalid.`,
      details: {
        version,
        nextAction: "Use list-versions to see available Minecraft versions.",
        suggestedCall: { tool: "list-versions", params: {} }
      }
    });
  }
  return value as VersionDetails;
}

export class VersionService {
  private readonly config: Config;
  private readonly fetchFn: typeof fetch;
  private readonly manifestUrl: string;
  private manifestCache: {
    value: VersionManifest;
    expiresAt: number;
  } | undefined;
  private readonly versionDetailCache = new Map<
    string,
    {
      value: VersionDetails;
      expiresAt: number;
    }
  >();
  private readonly resolveLocks = new Map<string, Promise<ResolvedVersionJar>>();

  constructor(config: Config, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.manifestUrl = process.env.MCP_VERSION_MANIFEST_URL ?? DEFAULT_VERSION_MANIFEST_URL;
  }

  async listVersions(input: ListVersionsInput = {}): Promise<ListVersionsOutput> {
    const manifest = await this.fetchManifest();
    const includeSnapshots = input.includeSnapshots ?? false;
    const limit = clampLimit(input.limit, 20, 200);
    const versions = manifest.versions ?? [];

    const releases = versions
      .filter((entry) => entry.type === "release")
      .map((entry) => ({ id: entry.id, unobfuscated: isUnobfuscatedVersion(entry.id) }))
      .slice(0, limit);
    const snapshots = versions
      .filter((entry) => entry.type === "snapshot")
      .map((entry) => ({ id: entry.id, unobfuscated: isUnobfuscatedVersion(entry.id) }))
      .slice(0, limit);
    const cached = (await this.loadCacheIndex()).entries.map((entry) => entry.version);

    return {
      latest: {
        release: manifest.latest?.release,
        snapshot: manifest.latest?.snapshot
      },
      releases,
      snapshots: includeSnapshots ? snapshots : undefined,
      cached: Array.from(new Set(cached)).sort((a, b) => a.localeCompare(b)),
      totalAvailable: versions.length
    };
  }

  async listVersionIds(input: ListVersionIdsInput = {}): Promise<string[]> {
    const manifest = await this.fetchManifest();
    const includeSnapshots = input.includeSnapshots ?? false;
    return (manifest.versions ?? [])
      .filter((entry) => entry.type === "release" || (includeSnapshots && entry.type === "snapshot"))
      .map((entry) => entry.id);
  }

  async resolveVersionJar(version: string): Promise<ResolvedVersionJar> {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty."
      });
    }

    const existingLock = this.resolveLocks.get(normalizedVersion);
    if (existingLock) {
      return existingLock;
    }

    const resolvePromise = this.resolveVersionJarInternal(normalizedVersion);
    this.resolveLocks.set(normalizedVersion, resolvePromise);

    try {
      return await resolvePromise;
    } finally {
      this.resolveLocks.delete(normalizedVersion);
    }
  }

  async resolveVersionMappings(version: string): Promise<ResolvedVersionMappings> {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty."
      });
    }

    const manifest = await this.fetchManifest();
    const versionEntry = (manifest.versions ?? []).find((entry) => entry.id === normalizedVersion);
    if (!versionEntry) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `Minecraft version "${normalizedVersion}" was not found in version manifest.`,
        details: {
          version: normalizedVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const details = await this.fetchVersionDetails(versionEntry.url, normalizedVersion);
    const clientMappingsUrl = details.downloads?.client_mappings?.url;
    return {
      version: normalizedVersion,
      versionManifestUrl: this.manifestUrl,
      versionDetailUrl: versionEntry.url,
      clientMappingsUrl,
      serverMappingsUrl: details.downloads?.server_mappings?.url,
      mappingsUrl: clientMappingsUrl
    };
  }

  async resolveServerJar(version: string): Promise<ResolvedServerJar> {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty."
      });
    }

    const manifest = await this.fetchManifest();
    const versionEntry = (manifest.versions ?? []).find((entry) => entry.id === normalizedVersion);
    if (!versionEntry) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `Minecraft version "${normalizedVersion}" was not found in version manifest.`,
        details: {
          version: normalizedVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const details = await this.fetchVersionDetails(versionEntry.url, normalizedVersion);
    const serverJarUrl = details.downloads?.server?.url;
    if (!serverJarUrl) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `Minecraft version "${normalizedVersion}" does not expose a server download URL.`,
        details: {
          version: normalizedVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const destinationPath = defaultDownloadPath(this.config.cacheDir, serverJarUrl);
    if (existsSync(destinationPath)) {
      return {
        version: normalizedVersion,
        jarPath: destinationPath,
        source: "downloaded",
        serverJarUrl
      };
    }

    const downloaded = await downloadToCache(serverJarUrl, destinationPath, {
      retries: this.config.fetchRetries,
      timeoutMs: this.config.fetchTimeoutMs,
      fetchFn: this.fetchFn
    });

    if (!downloaded.ok || !downloaded.path) {
      throw createError({
        code: ERROR_CODES.REPO_FETCH_FAILED,
        message: `Failed to download Minecraft server jar for version "${normalizedVersion}".`,
        details: {
          version: normalizedVersion,
          url: serverJarUrl,
          statusCode: downloaded.statusCode
        }
      });
    }

    const expectedSha1 = details.downloads?.server?.sha1;
    if (expectedSha1) {
      const actualSha1 = await computeFileSha1(downloaded.path);
      if (actualSha1 !== expectedSha1) {
        await unlink(downloaded.path).catch(() => {});
        throw createError({
          code: ERROR_CODES.REPO_FETCH_FAILED,
          message: `SHA-1 mismatch for downloaded server jar of version "${normalizedVersion}".`,
          details: {
            version: normalizedVersion,
            url: serverJarUrl,
            expected: expectedSha1,
            actual: actualSha1
          }
        });
      }
    }

    return {
      version: normalizedVersion,
      jarPath: downloaded.path,
      source: "downloaded",
      serverJarUrl
    };
  }

  private async fetchManifest(): Promise<VersionManifest> {
    const now = Date.now();
    if (this.manifestCache && this.manifestCache.expiresAt > now) {
      return this.manifestCache.value;
    }

    const manifest = await this.fetchJson(this.manifestUrl);
    if (!isVersionManifest(manifest)) {
      throw createError({
        code: ERROR_CODES.REPO_FETCH_FAILED,
        message: "Minecraft version manifest response is invalid.",
        details: { manifestUrl: this.manifestUrl }
      });
    }

    this.manifestCache = {
      value: manifest,
      expiresAt: now + MANIFEST_CACHE_TTL_MS
    };
    return manifest;
  }

  private async resolveVersionJarInternal(normalizedVersion: string): Promise<ResolvedVersionJar> {
    const cachedIndex = await this.loadCacheIndex();
    const cachedEntry = cachedIndex.entries.find((entry) => entry.version === normalizedVersion);
    if (cachedEntry && existsSync(cachedEntry.jarPath)) {
      return {
        version: normalizedVersion,
        jarPath: cachedEntry.jarPath,
        source: "downloaded",
        clientJarUrl: "cache:index"
      };
    }

    const manifest = await this.fetchManifest();
    const versionEntry = (manifest.versions ?? []).find((entry) => entry.id === normalizedVersion);
    if (!versionEntry) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `Minecraft version "${normalizedVersion}" was not found in version manifest.`,
        details: {
          version: normalizedVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const details = await this.fetchVersionDetails(versionEntry.url, normalizedVersion);
    const clientJarUrl = details.downloads?.client?.url;
    if (!clientJarUrl) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `Minecraft version "${normalizedVersion}" does not expose a client download URL.`,
        details: {
          version: normalizedVersion,
          nextAction: "Use list-versions to see available Minecraft versions.",
          suggestedCall: { tool: "list-versions", params: {} }
        }
      });
    }

    const destinationPath = defaultDownloadPath(this.config.cacheDir, clientJarUrl);
    if (existsSync(destinationPath)) {
      await this.recordCacheEntry({
        version: normalizedVersion,
        jarPath: destinationPath,
        downloadedAt: new Date().toISOString()
      });
      return {
        version: normalizedVersion,
        jarPath: destinationPath,
        source: "downloaded",
        clientJarUrl
      };
    }

    const downloaded = await downloadToCache(clientJarUrl, destinationPath, {
      retries: this.config.fetchRetries,
      timeoutMs: this.config.fetchTimeoutMs,
      fetchFn: this.fetchFn
    });

    if (!downloaded.ok || !downloaded.path) {
      throw createError({
        code: ERROR_CODES.REPO_FETCH_FAILED,
        message: `Failed to download Minecraft client jar for version "${normalizedVersion}".`,
        details: {
          version: normalizedVersion,
          url: clientJarUrl,
          statusCode: downloaded.statusCode
        }
      });
    }

    const expectedSha1 = details.downloads?.client?.sha1;
    if (expectedSha1) {
      const actualSha1 = await computeFileSha1(downloaded.path);
      if (actualSha1 !== expectedSha1) {
        await unlink(downloaded.path).catch(() => {});
        throw createError({
          code: ERROR_CODES.REPO_FETCH_FAILED,
          message: `SHA-1 mismatch for downloaded jar of version "${normalizedVersion}".`,
          details: {
            version: normalizedVersion,
            url: clientJarUrl,
            expected: expectedSha1,
            actual: actualSha1
          }
        });
      }
    }

    await this.recordCacheEntry({
      version: normalizedVersion,
      jarPath: downloaded.path,
      downloadedAt: new Date().toISOString()
    });

    return {
      version: normalizedVersion,
      jarPath: downloaded.path,
      source: "downloaded",
      clientJarUrl
    };
  }

  private async fetchVersionDetails(versionUrl: string, version: string): Promise<VersionDetails> {
    const now = Date.now();
    const cached = this.versionDetailCache.get(versionUrl);
    if (cached && cached.expiresAt > now) {
      this.versionDetailCache.delete(versionUrl);
      this.versionDetailCache.set(versionUrl, cached);
      return cached.value;
    }

    const detailRaw = await this.fetchJson(versionUrl);
    const details = ensureVersionDetail(detailRaw, version);
    this.versionDetailCache.set(versionUrl, {
      value: details,
      expiresAt: now + VERSION_DETAIL_CACHE_TTL_MS
    });
    this.trimVersionDetailCache();
    return details;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw createError({
        code: ERROR_CODES.REPO_FETCH_FAILED,
        message: `Request failed for "${url}" with status ${response.status}.`,
        details: {
          url,
          statusCode: response.status
        }
      });
    }

    try {
      return await response.json();
    } catch {
      throw createError({
        code: ERROR_CODES.REPO_FETCH_FAILED,
        message: `Response from "${url}" is not valid JSON.`,
        details: { url }
      });
    }
  }

  private cacheIndexPath(): string {
    return join(this.config.cacheDir, "versions", "index.json");
  }

  private async loadCacheIndex(): Promise<VersionCacheIndex> {
    const indexPath = this.cacheIndexPath();
    try {
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as VersionCacheIndex;
      if (!Array.isArray(parsed.entries)) {
        return { entries: [] };
      }

      return {
        entries: parsed.entries.filter(
          (entry) =>
            typeof entry === "object" &&
            entry != null &&
            typeof entry.version === "string" &&
            typeof entry.jarPath === "string" &&
            typeof entry.downloadedAt === "string"
        ) as VersionCacheEntry[]
      };
    } catch {
      return { entries: [] };
    }
  }

  private async recordCacheEntry(entry: VersionCacheEntry): Promise<void> {
    const indexPath = this.cacheIndexPath();
    const existing = await this.loadCacheIndex();
    const deduped = existing.entries.filter((candidate) => candidate.version !== entry.version);
    deduped.push(entry);
    deduped.sort((left, right) => right.downloadedAt.localeCompare(left.downloadedAt));

    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          entries: deduped
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  private trimVersionDetailCache(): void {
    const maxEntries = Math.max(1, this.config.maxVersionDetailCache ?? 256);
    const overflow = this.versionDetailCache.size - maxEntries;
    if (overflow <= 0) {
      return;
    }

    const keyIterator = this.versionDetailCache.keys();
    for (let index = 0; index < overflow; index += 1) {
      const oldest = keyIterator.next().value as string | undefined;
      if (!oldest) {
        return;
      }
      this.versionDetailCache.delete(oldest);
    }
  }
}

/**
 * MC 26.1+ uses new YY.N version format and ships unobfuscated source.
 * Legacy 1.x.y versions remain obfuscated.
 * Snapshots: "26w01a" (year >= 26) → unobfuscated, "24w01a" → obfuscated.
 */
export function isUnobfuscatedVersion(version: string): boolean {
  if (!version) return false;

  // Snapshot format: YYwNNa (e.g. "26w01a")
  const snapshotMatch = version.match(/^(\d{2})w\d{2}[a-z]$/);
  if (snapshotMatch) {
    return Number(snapshotMatch[1]) >= 26;
  }

  // New format: YY.N or YY.N.P, optionally with -preN/-rcN suffix.
  // Examples: "26.1", "27.3.1", "26.1-pre1", "26.1-rc1"
  const newFormatMatch = version.match(/^(\d{2,})\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?$/);
  if (newFormatMatch) {
    return Number(newFormatMatch[1]) >= 26;
  }

  // Legacy 1.x.y → obfuscated; unknown → false (safe default)
  return false;
}
