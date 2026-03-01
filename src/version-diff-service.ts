import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { listJarEntries } from "./source-jar-reader.js";
import { VersionService } from "./version-service.js";
import { RegistryService, type RegistryData } from "./registry-service.js";
import type { Config } from "./types.js";

export type CompareVersionsCategory = "classes" | "registry" | "all";

export type CompareVersionsInput = {
  fromVersion: string;
  toVersion: string;
  category?: CompareVersionsCategory;
  packageFilter?: string;
  maxClassResults?: number;
};

export type CompareVersionsOutput = {
  fromVersion: string;
  toVersion: string;
  classes?: {
    added: string[];
    removed: string[];
    addedCount: number;
    removedCount: number;
    unchanged: number;
  };
  registry?: {
    added: Record<string, string[]>;
    removed: Record<string, string[]>;
    newRegistries: string[];
    removedRegistries: string[];
    summary: {
      registriesChanged: number;
      totalAdded: number;
      totalRemoved: number;
    };
  };
  warnings: string[];
};

const DEFAULT_MAX_CLASS_RESULTS = 500;
const MAX_CLASS_RESULTS_LIMIT = 5000;

function classInternalToFqn(internalPath: string): string {
  // Remove .class suffix and convert / to .
  return internalPath.replace(/\.class$/, "").replaceAll("/", ".");
}

function extractClassEntries(entries: string[]): Set<string> {
  const classes = new Set<string>();
  for (const entry of entries) {
    if (
      entry.endsWith(".class") &&
      !entry.includes("META-INF/") &&
      !entry.includes("$")
    ) {
      classes.add(classInternalToFqn(entry));
    }
  }
  return classes;
}

function filterByPackage(classes: string[], prefix: string): string[] {
  const normalized = prefix.endsWith(".") ? prefix : `${prefix}.`;
  return classes.filter((fqn) => fqn.startsWith(normalized));
}

function diffSets(from: Set<string>, to: Set<string>): { added: string[]; removed: string[]; unchanged: number } {
  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const entry of to) {
    if (!from.has(entry)) added.push(entry);
    else unchanged++;
  }
  for (const entry of from) {
    if (!to.has(entry)) removed.push(entry);
  }

  added.sort();
  removed.sort();
  return { added, removed, unchanged };
}

function diffRegistries(
  fromRegistries: Record<string, RegistryData>,
  toRegistries: Record<string, RegistryData>
): CompareVersionsOutput["registry"] {
  const fromKeys = new Set(Object.keys(fromRegistries));
  const toKeys = new Set(Object.keys(toRegistries));

  const newRegistries: string[] = [];
  const removedRegistries: string[] = [];
  for (const key of toKeys) {
    if (!fromKeys.has(key)) newRegistries.push(key);
  }
  for (const key of fromKeys) {
    if (!toKeys.has(key)) removedRegistries.push(key);
  }
  newRegistries.sort();
  removedRegistries.sort();

  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  let totalAdded = 0;
  let totalRemoved = 0;
  let registriesChanged = 0;

  // Compare entries in registries present in both versions
  const commonRegistries = [...fromKeys].filter((key) => toKeys.has(key));
  for (const registryName of commonRegistries) {
    const fromEntries = new Set(Object.keys(fromRegistries[registryName].entries));
    const toEntries = new Set(Object.keys(toRegistries[registryName].entries));

    const addedEntries: string[] = [];
    const removedEntries: string[] = [];

    for (const entry of toEntries) {
      if (!fromEntries.has(entry)) addedEntries.push(entry);
    }
    for (const entry of fromEntries) {
      if (!toEntries.has(entry)) removedEntries.push(entry);
    }

    if (addedEntries.length > 0 || removedEntries.length > 0) {
      registriesChanged++;
      if (addedEntries.length > 0) {
        addedEntries.sort();
        added[registryName] = addedEntries;
        totalAdded += addedEntries.length;
      }
      if (removedEntries.length > 0) {
        removedEntries.sort();
        removed[registryName] = removedEntries;
        totalRemoved += removedEntries.length;
      }
    }
  }

  // Count new registries' entries as added
  for (const regName of newRegistries) {
    const entries = Object.keys(toRegistries[regName].entries);
    if (entries.length > 0) {
      entries.sort();
      added[regName] = entries;
      totalAdded += entries.length;
      registriesChanged++;
    }
  }

  // Count removed registries' entries as removed
  for (const regName of removedRegistries) {
    const entries = Object.keys(fromRegistries[regName].entries);
    if (entries.length > 0) {
      entries.sort();
      removed[regName] = entries;
      totalRemoved += entries.length;
      registriesChanged++;
    }
  }

  return {
    added,
    removed,
    newRegistries,
    removedRegistries,
    summary: {
      registriesChanged,
      totalAdded,
      totalRemoved
    }
  };
}

export class VersionDiffService {
  private readonly config: Config;
  private readonly versionService: VersionService;
  private readonly registryService: RegistryService;

  constructor(config: Config, versionService: VersionService, registryService: RegistryService) {
    this.config = config;
    this.versionService = versionService;
    this.registryService = registryService;
  }

  async compareVersions(input: CompareVersionsInput): Promise<CompareVersionsOutput> {
    const fromVersion = input.fromVersion.trim();
    const toVersion = input.toVersion.trim();
    const category = input.category ?? "all";
    const maxClassResults = Math.min(
      input.maxClassResults ?? DEFAULT_MAX_CLASS_RESULTS,
      MAX_CLASS_RESULTS_LIMIT
    );

    if (!fromVersion || !toVersion) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "fromVersion and toVersion must be non-empty."
      });
    }

    const warnings: string[] = [];
    const startedAt = Date.now();
    log("info", "version-diff.start", { fromVersion, toVersion, category });

    const includeClasses = category === "classes" || category === "all";
    const includeRegistry = category === "registry" || category === "all";

    let classesResult: CompareVersionsOutput["classes"];
    let registryResult: CompareVersionsOutput["registry"];

    // Run class and registry comparisons in parallel where possible
    const tasks: Promise<void>[] = [];

    if (includeClasses) {
      tasks.push(
        (async () => {
          const [fromJar, toJar] = await Promise.all([
            this.versionService.resolveVersionJar(fromVersion),
            this.versionService.resolveVersionJar(toVersion)
          ]);

          const [fromEntries, toEntries] = await Promise.all([
            listJarEntries(fromJar.jarPath),
            listJarEntries(toJar.jarPath)
          ]);

          const fromClasses = extractClassEntries(fromEntries);
          const toClasses = extractClassEntries(toEntries);
          let { added, removed, unchanged } = diffSets(fromClasses, toClasses);

          if (input.packageFilter) {
            added = filterByPackage(added, input.packageFilter);
            removed = filterByPackage(removed, input.packageFilter);
          }

          const truncatedAdded = added.slice(0, maxClassResults);
          const truncatedRemoved = removed.slice(0, maxClassResults);

          if (added.length > maxClassResults) {
            warnings.push(
              `Class additions truncated: showing ${maxClassResults} of ${added.length}. Use packageFilter to narrow results.`
            );
          }
          if (removed.length > maxClassResults) {
            warnings.push(
              `Class removals truncated: showing ${maxClassResults} of ${removed.length}. Use packageFilter to narrow results.`
            );
          }

          classesResult = {
            added: truncatedAdded,
            removed: truncatedRemoved,
            addedCount: added.length,
            removedCount: removed.length,
            unchanged
          };
        })()
      );
    }

    if (includeRegistry) {
      tasks.push(
        (async () => {
          try {
            const [fromReg, toReg] = await Promise.all([
              this.registryService.getRegistryData({ version: fromVersion }),
              this.registryService.getRegistryData({ version: toVersion })
            ]);

            const fromData = fromReg.data as Record<string, RegistryData>;
            const toData = toReg.data as Record<string, RegistryData>;

            registryResult = diffRegistries(fromData, toData);
          } catch (error) {
            if (category === "registry") {
              throw error;
            }
            const msg =
              error instanceof Error ? error.message : String(error);
            warnings.push(`Registry comparison failed: ${msg}`);
          }
        })()
      );
    }

    await Promise.all(tasks);

    log("info", "version-diff.done", {
      fromVersion,
      toVersion,
      durationMs: Date.now() - startedAt
    });

    return {
      fromVersion,
      toVersion,
      classes: classesResult,
      registry: registryResult,
      warnings
    };
  }
}
