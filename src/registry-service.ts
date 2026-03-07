import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { VersionService } from "./version-service.js";
import type { Config } from "./types.js";

const DATAGEN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDIO_SNAPSHOT = 6_240;

export type GetRegistryDataInput = {
  version: string;
  registry?: string;
  includeData?: boolean;
  maxEntriesPerRegistry?: number;
};

export type RegistryEntry = {
  protocol_id: number;
};

export type RegistryData = {
  default?: string;
  entries: Record<string, RegistryEntry>;
};

export type GetRegistryDataOutput = {
  version: string;
  registry?: string;
  registries?: string[];
  data?: Record<string, RegistryData> | RegistryData;
  entryCount: number;
  returnedEntryCount?: number;
  registryEntryCounts?: Record<string, number>;
  dataTruncated?: boolean;
  warnings: string[];
};

function clampPositiveInt(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value == null) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

function sortedRegistryEntryNames(entries: Record<string, RegistryEntry>): string[] {
  return Object.keys(entries).sort((left, right) => left.localeCompare(right));
}

function limitRegistryEntries(
  data: RegistryData,
  maxEntries: number | undefined
): { data: RegistryData; total: number; returned: number; truncated: boolean } {
  const entryNames = sortedRegistryEntryNames(data.entries);
  const total = entryNames.length;
  if (maxEntries == null || total <= maxEntries) {
    return {
      data,
      total,
      returned: total,
      truncated: false
    };
  }

  const limitedEntries: Record<string, RegistryEntry> = {};
  for (const entryName of entryNames.slice(0, maxEntries)) {
    limitedEntries[entryName] = data.entries[entryName] as RegistryEntry;
  }

  return {
    data: {
      default: data.default,
      entries: limitedEntries
    },
    total,
    returned: maxEntries,
    truncated: true
  };
}

function limitOutput(text: string): string {
  if (text.length <= MAX_STDIO_SNAPSHOT) return text;
  return text.slice(-MAX_STDIO_SNAPSHOT);
}

function resolveRegistryPaths(registryDir: string): string[] {
  return [
    join(registryDir, "reports", "registries.json"),
    join(registryDir, "generated", "reports", "registries.json"),
    join(registryDir, "registries.json")
  ];
}

function findRegistryFile(registryDir: string): string | undefined {
  for (const candidate of resolveRegistryPaths(registryDir)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parseRegistrySnapshot(
  raw: string,
  version: string,
  registryFile: string
): Record<string, RegistryData> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw createError({
      code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
      message: `Failed to parse registries.json for version "${version}".`,
      details: {
        version,
        registryFile,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw createError({
      code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
      message: `registries.json for version "${version}" has invalid structure.`,
      details: { version, registryFile }
    });
  }

  return parsed as Record<string, RegistryData>;
}

function runDataGen(
  serverJarPath: string,
  outputDir: string,
  version: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // MC 1.18+ uses bundler format, older versions use -cp with main class directly.
    // The bundler approach works for 1.18+ and the -cp approach for older versions.
    // We try bundler first since most modern versions use it.
    const isLegacy = isLegacyVersion(version);

    const args = isLegacy
      ? [
          "-cp", serverJarPath,
          "-Xmx2G", "-Xms512M",
          "net.minecraft.data.Main",
          "--reports", "--all", "--server",
          "--output", outputDir
        ]
      : [
          "-DbundlerMainClass=net.minecraft.data.Main",
          "-Xmx2G", "-Xms512M",
          "-jar", serverJarPath,
          "--reports", "--all", "--server",
          "--output", outputDir
        ];

    log("info", "registry.datagen.start", { version, isLegacy, serverJarPath, outputDir });

    const proc = spawn("java", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: outputDir
    });

    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        createError({
          code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
          message: `Registry data generation timed out for version "${version}".`,
          details: { version, timeoutMs: DATAGEN_TIMEOUT_MS, stderrTail: limitOutput(stderr) }
        })
      );
    }, DATAGEN_TIMEOUT_MS);

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      stderr = limitOutput(stderr);
    });

    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(
        createError({
          code: ERROR_CODES.JAVA_UNAVAILABLE,
          message: "java command is not available for data generation.",
          details: { error: error instanceof Error ? error.message : String(error) }
        })
      );
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          createError({
            code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
            message: `Data generation exited with code ${code} for version "${version}".`,
            details: { version, code, stderrTail: limitOutput(stderr) }
          })
        );
        return;
      }
      log("info", "registry.datagen.done", { version });
      resolve();
    });
  });
}

/**
 * MC versions before 1.18 use -cp instead of -jar bundler format for data gen.
 * 1.18 snapshots start with "21w" (2021 weekly), release is "1.18".
 */
function isLegacyVersion(version: string): boolean {
  // Snapshot format: YYwNNa
  const snapshotMatch = version.match(/^(\d{2})w(\d{2})[a-z]$/);
  if (snapshotMatch) {
    const year = Number(snapshotMatch[1]);
    const week = Number(snapshotMatch[2]);
    // 1.18 started in 21w37a
    if (year < 21) return true;
    if (year === 21 && week < 37) return true;
    return false;
  }

  // Release format: 1.X or 1.X.Y
  const releaseMatch = version.match(/^1\.(\d+)(?:\.\d+)?(?:-.*)?$/);
  if (releaseMatch) {
    return Number(releaseMatch[1]) < 18;
  }

  // New format (26.1+) is never legacy
  return false;
}

export class RegistryService {
  private readonly config: Config;
  private readonly versionService: VersionService;
  private readonly registryCache = new Map<string, Record<string, RegistryData>>();

  constructor(config: Config, versionService: VersionService) {
    this.config = config;
    this.versionService = versionService;
  }

  async getRegistryData(input: GetRegistryDataInput): Promise<GetRegistryDataOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty."
      });
    }

    const warnings: string[] = [];
    const allRegistries = await this.loadRegistries(version, warnings);
    const registryNames = Object.keys(allRegistries).sort();
    const includeData = input.includeData ?? true;
    const maxEntriesPerRegistry = clampPositiveInt(input.maxEntriesPerRegistry);
    const registryEntryCounts = Object.fromEntries(
      registryNames.map((registryName) => [
        registryName,
        Object.keys(allRegistries[registryName]!.entries).length
      ])
    );

    if (input.registry) {
      const registryName = normalizeRegistryName(input.registry);
      const data = allRegistries[registryName];
      if (!data) {
        throw createError({
          code: ERROR_CODES.SOURCE_NOT_FOUND,
          message: `Registry "${registryName}" not found for version "${version}".`,
          details: {
            version,
            registry: registryName,
            available: registryNames.slice(0, 20)
          }
        });
      }

      const limited = limitRegistryEntries(data, maxEntriesPerRegistry);

      return {
        version,
        registry: registryName,
        ...(includeData ? { data: limited.data } : {}),
        entryCount: limited.total,
        returnedEntryCount: includeData ? limited.returned : 0,
        registryEntryCounts: {
          [registryName]: limited.total
        },
        ...(limited.truncated ? { dataTruncated: true } : {}),
        warnings
      };
    }

    let totalEntries = 0;
    for (const registry of Object.values(allRegistries)) {
      totalEntries += Object.keys(registry.entries).length;
    }

    let returnedEntryCount = 0;
    let dataTruncated = false;
    const limitedData: Record<string, RegistryData> = {};
    if (includeData) {
      for (const registryName of registryNames) {
        const limited = limitRegistryEntries(allRegistries[registryName]!, maxEntriesPerRegistry);
        limitedData[registryName] = limited.data;
        returnedEntryCount += limited.returned;
        dataTruncated ||= limited.truncated;
      }
    }

    return {
      version,
      registries: registryNames,
      ...(includeData ? { data: limitedData } : {}),
      entryCount: totalEntries,
      returnedEntryCount: includeData ? returnedEntryCount : 0,
      registryEntryCounts,
      ...(dataTruncated ? { dataTruncated: true } : {}),
      warnings
    };
  }

  private async loadRegistries(
    version: string,
    warnings: string[]
  ): Promise<Record<string, RegistryData>> {
    const cached = this.registryCache.get(version);
    if (cached) return cached;

    const registryDir = join(this.config.cacheDir, "registries", version);

    const cachedRegistries = this.loadExistingRegistries(registryDir, version, warnings);
    if (cachedRegistries) {
      this.cacheRegistries(version, cachedRegistries);
      return cachedRegistries;
    }

    await mkdir(registryDir, { recursive: true });

    const serverJar = await this.versionService.resolveServerJar(version);
    await runDataGen(serverJar.jarPath, registryDir, version);

    const registryFile = findRegistryFile(registryDir);
    if (!registryFile) {
      throw createError({
        code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
        message: `Registry data generation did not produce registries.json for version "${version}".`,
        details: { version, registryDir }
      });
    }

    const parsed = this.readRegistryFileOrThrow(registryFile, version);
    this.cacheRegistries(version, parsed);
    return parsed;
  }

  private loadExistingRegistries(
    registryDir: string,
    version: string,
    warnings: string[]
  ): Record<string, RegistryData> | undefined {
    for (const candidate of resolveRegistryPaths(registryDir)) {
      if (!existsSync(candidate)) {
        continue;
      }

      try {
        return this.readRegistryFileOrThrow(candidate, version);
      } catch (error) {
        if (!this.isInvalidRegistrySnapshot(error)) {
          throw error;
        }

        warnings.push(`Ignored corrupt cached registry snapshot and regenerated it: ${candidate}`);
        log("warn", "registry.cache.invalidated", {
          version,
          registryFile: candidate,
          reason: error.message
        });
        try {
          rmSync(candidate, { force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }

    return undefined;
  }

  private readRegistryFileOrThrow(
    registryFile: string,
    version: string
  ): Record<string, RegistryData> {
    let raw: string;
    try {
      raw = readFileSync(registryFile, "utf8");
    } catch (error) {
      throw createError({
        code: ERROR_CODES.REGISTRY_GENERATION_FAILED,
        message: `Failed to read registries.json for version "${version}".`,
        details: {
          version,
          registryFile,
          reason: error instanceof Error ? error.message : String(error)
        }
      });
    }

    return parseRegistrySnapshot(raw, version, registryFile);
  }

  private isInvalidRegistrySnapshot(error: unknown): error is Error & { code?: string } {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === ERROR_CODES.REGISTRY_GENERATION_FAILED
    );
  }

  private cacheRegistries(version: string, parsed: Record<string, RegistryData>): void {
    this.registryCache.set(version, parsed);

    // Trim cache to avoid unbounded growth
    if (this.registryCache.size > 8) {
      const oldest = this.registryCache.keys().next().value;
      if (oldest !== undefined) this.registryCache.delete(oldest);
    }
  }
}

function normalizeRegistryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(":")) return trimmed;
  return `minecraft:${trimmed}`;
}
