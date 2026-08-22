import { readFile } from "node:fs/promises";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { resolveMojangTinyFile } from "./mojang-tiny-mapping-service.js";
import { listJarEntries } from "./source-jar-reader.js";
import { VersionService } from "./version-service.js";
import { RegistryService, type RegistryData } from "./registry-service.js";
import type { Config } from "./types.js";

export type CompareVersionsCategory = "classes" | "registry" | "all";

/**
 * Namespace the compared class names live in.
 *
 * A vanilla client jar for an obfuscated release lists `dlp.class`, not
 * `net/minecraft/world/item/Item.class`, so a diff taken straight off the jar
 * entries answers in obfuscated names. Every caller-facing name — the `added`
 * and `removed` lists AND `packageFilter` — is expressed in mojang names when
 * the official mappings for both versions can be loaded, and the namespace is
 * always reported so a zero result is never ambiguous.
 */
export type ClassDiffNamespace = "mojang" | "obfuscated";

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
    /** Namespace the class names above (and any packageFilter) are expressed in. */
    namespace: ClassDiffNamespace;
    /** Present only when the caller passed packageFilter; reports what it matched. */
    packageFilter?: {
      value: string;
      namespace: ClassDiffNamespace;
      matchedFrom: number;
      matchedTo: number;
    };
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

function filterSetByPackage(classes: Set<string>, prefix: string): Set<string> {
  return new Set(filterByPackage([...classes], prefix));
}

/**
 * True when the jar's class names are obfuscated.
 *
 * Obfuscation collapses every Minecraft class into the DEFAULT package with a
 * short generated name (`dlp`, `ije`), so a jar where a large share of the
 * classes carry no package at all is obfuscated. Unobfuscated releases, jars
 * remapped before listing, and ordinary library/mod jars all keep real package
 * structure and need no mapping load.
 */
function looksObfuscated(classes: Set<string>): boolean {
  if (classes.size === 0) {
    return false;
  }
  let defaultPackage = 0;
  for (const fqn of classes) {
    if (!fqn.includes(".")) {
      defaultPackage += 1;
    }
  }
  return defaultPackage > 0 && defaultPackage * 4 >= classes.size;
}

/** Parses the `c<TAB>obf<TAB>mojang` rows of a merged mojang tiny v2 file. */
function parseTinyClassRows(content: string): Map<string, string> {
  const classMap = new Map<string, string>();
  for (const line of content.split("\n")) {
    if (line.charCodeAt(0) !== 99 /* 'c' */ || line.charCodeAt(1) !== 9 /* TAB */) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const obfuscated = parts[1];
    const mojang = parts[2];
    if (!obfuscated || !mojang) {
      continue;
    }
    classMap.set(obfuscated.replaceAll("/", "."), mojang.replaceAll("/", "."));
  }
  return classMap;
}

/** Bounded per-process memo so a repeated comparison re-reads nothing. */
const MOJANG_CLASS_MAP_CACHE_LIMIT = 4;

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
  private readonly mojangClassMaps = new Map<string, Map<string, string>>();

  constructor(config: Config, versionService: VersionService, registryService: RegistryService) {
    this.config = config;
    this.versionService = versionService;
    this.registryService = registryService;
  }

  /**
   * obfuscated -> mojang class map for one version, or undefined when the
   * official mappings cannot be obtained (offline, or a release that publishes
   * none). Never throws: a missing map degrades the diff to obfuscated names
   * with a warning rather than failing the comparison.
   */
  private async loadMojangClassMap(version: string): Promise<Map<string, string> | undefined> {
    const cached = this.mojangClassMaps.get(version);
    if (cached) {
      return cached;
    }
    try {
      const { path } = await resolveMojangTinyFile(version, this.config, {
        versionService: this.versionService
      });
      const classMap = parseTinyClassRows(await readFile(path, "utf8"));
      if (classMap.size === 0) {
        return undefined;
      }
      if (this.mojangClassMaps.size >= MOJANG_CLASS_MAP_CACHE_LIMIT) {
        const oldest = this.mojangClassMaps.keys().next().value;
        if (oldest !== undefined) {
          this.mojangClassMaps.delete(oldest);
        }
      }
      this.mojangClassMaps.set(version, classMap);
      return classMap;
    } catch (error) {
      log("warn", "version-diff.mojang_class_map_unavailable", {
        version,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  /**
   * Lifts one version's jar class list into mojang names when possible.
   * Returns the namespace the returned set is actually expressed in.
   */
  private async toMojangNames(
    version: string,
    classes: Set<string>
  ): Promise<{ classes: Set<string>; namespace: ClassDiffNamespace; unmapped: number }> {
    if (!looksObfuscated(classes)) {
      return { classes, namespace: "mojang", unmapped: 0 };
    }
    const classMap = await this.loadMojangClassMap(version);
    if (!classMap) {
      return { classes, namespace: "obfuscated", unmapped: classes.size };
    }
    const mapped = new Set<string>();
    let unmapped = 0;
    for (const fqn of classes) {
      const mojang = classMap.get(fqn);
      if (mojang) {
        mapped.add(mojang);
      } else {
        // Library classes shipped inside the jar (and anything the mappings do
        // not cover) keep the name the jar carries; they are already readable.
        mapped.add(fqn);
        unmapped += 1;
      }
    }
    return { classes: mapped, namespace: "mojang", unmapped };
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
    if (
      input.maxClassResults != null &&
      Number.isFinite(input.maxClassResults) &&
      input.maxClassResults > MAX_CLASS_RESULTS_LIMIT
    ) {
      warnings.push(`maxClassResults was clamped to ${MAX_CLASS_RESULTS_LIMIT} from ${input.maxClassResults}.`);
    }
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

          // The class names must be lifted OUT of the jar's own namespace
          // before anything is compared or filtered: a mojang packageFilter
          // against obfuscated jar entries matched nothing and reported a
          // silent all-zero diff that read as "no changes".
          const [fromNames, toNames] = await Promise.all([
            this.toMojangNames(fromVersion, extractClassEntries(fromEntries)),
            this.toMojangNames(toVersion, extractClassEntries(toEntries))
          ]);
          const namespace: ClassDiffNamespace =
            fromNames.namespace === "mojang" && toNames.namespace === "mojang"
              ? "mojang"
              : "obfuscated";
          if (namespace === "obfuscated") {
            warnings.push(
              `Official Mojang mappings could not be loaded for ${
                fromNames.namespace === "obfuscated" ? fromVersion : toVersion
              }, so class names (and packageFilter) are compared in the OBFUSCATED namespace. Deobfuscated prefixes such as "net.minecraft.world.item" cannot match here.`
            );
          }

          const fromClasses = fromNames.classes;
          const toClasses = toNames.classes;
          const filteredFromClasses = input.packageFilter
            ? filterSetByPackage(fromClasses, input.packageFilter)
            : fromClasses;
          const filteredToClasses = input.packageFilter
            ? filterSetByPackage(toClasses, input.packageFilter)
            : toClasses;

          if (input.packageFilter && filteredFromClasses.size === 0 && filteredToClasses.size === 0) {
            // An empty diff and a non-matching filter look identical on the
            // wire, so the filter has to say which one happened.
            warnings.push(
              `packageFilter "${input.packageFilter}" matched no class in either ${fromVersion} or ${toVersion}; ` +
                `the reported zeros mean "filter matched nothing", not "nothing changed". ` +
                `Class names are compared in the ${namespace} namespace — ` +
                (namespace === "obfuscated"
                  ? "an obfuscated jar has no package structure to filter on, so omit packageFilter."
                  : "check the package prefix spelling, e.g. \"net.minecraft.world.item\".")
            );
          }

          const { added, removed, unchanged } = diffSets(filteredFromClasses, filteredToClasses);

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
            unchanged,
            namespace,
            ...(input.packageFilter
              ? {
                  packageFilter: {
                    value: input.packageFilter,
                    namespace,
                    matchedFrom: filteredFromClasses.size,
                    matchedTo: filteredToClasses.size
                  }
                }
              : {})
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
