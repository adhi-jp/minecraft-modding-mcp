import { z } from "zod";

import type { RegistryData } from "../../registry-service.js";
import { isUnobfuscatedIdentityPair } from "../../source/lifecycle/mapping-helpers.js";
import type { DiffClassSignaturesOutput } from "../../source-service.js";
import type { SourceMapping } from "../../types.js";
import { diffLibraries, type CompareVersionsOutput, type LibraryDiffResult } from "../../version-diff-service.js";
import { DeadlineExceededError, withDeadline } from "../deadline.js";
import { defined } from "../items.js";
import { detailSchema, mappingSchema, nonEmptyString, numericInput, type DetailLevel } from "../schemas.js";
import type {
  CatalogNextAction,
  CatalogServices,
  CatalogStatus,
  CatalogToolSpec,
  CatalogTruncation,
  CatalogWarning
} from "../types.js";

/**
 * Comparison family: what changed between two Minecraft versions (classes,
 * registry entries, libraries), how one class's members changed, and what a
 * version's generated registries hold. All three tools read version jars,
 * mappings or generated data and run behind the shared heavy-tool gate.
 */

const COMPARE_CATEGORIES = ["classes", "registry", "all"] as const;

/**
 * A registry name as the registry service reads it: a name without a
 * namespace belongs to `minecraft` (`block` is `minecraft:block`).
 */
function normalizeRegistryName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// version-compare
// ---------------------------------------------------------------------------

const versionCompareInput = z
  .strictObject({
    fromVersion: nonEmptyString.describe('Older Minecraft version, e.g. "1.21.1".'),
    toVersion: nonEmptyString.describe('Newer Minecraft version, e.g. "1.21.10".'),
    category: z.enum(COMPARE_CATEGORIES).default("all").describe("What to compare; default all."),
    packageFilter: nonEmptyString.optional().describe('Classes only: package prefix, e.g. "net.minecraft.world.item".'),
    registry: nonEmptyString.optional().describe('Registry only: one registry, e.g. "block" or "minecraft:item".'),
    limit: numericInput(z.number().int().min(1).max(5000))
      .default(500)
      .describe("Class names per added/removed list; default 500."),
    withLibraries: z.boolean().default(false).describe("Add the library delta of the two version manifests."),
    detail: detailSchema("summary").describe(
      "summary: counts; standard: class and library names; full: also registry entries."
    )
  })
  .superRefine((value, ctx) => {
    if (value.registry !== undefined && value.category === "classes") {
      ctx.addIssue({
        code: "custom",
        path: ["registry"],
        message: '"registry" narrows the registry comparison; it is not accepted with category "classes".'
      });
    }
    if (value.packageFilter !== undefined && value.category === "registry") {
      ctx.addIssue({
        code: "custom",
        path: ["packageFilter"],
        message: '"packageFilter" narrows the class comparison; it is not accepted with category "registry".'
      });
    }
  });

type VersionCompareInput = z.output<typeof versionCompareInput>;

type RegistryDelta = NonNullable<CompareVersionsOutput["registry"]>;

/** How long the two version manifests' library lists may take before the comparison goes on without them. */
const LIBRARY_DEADLINE_MS = 5_000;

/** The version-diff service's own sentences about a class list cut at the limit. */
const CLASS_LIST_CUT_SENTENCE = /^Class (?:additions|removals) truncated: showing \d+ of \d+\. Use packageFilter to narrow results\.$/;
/** The version-diff service's sentence for a registry comparison that failed under category "all". */
const REGISTRY_FAILED_SENTENCE = /^Registry comparison failed: /;

/** The registry delta restricted to one registry. */
function narrowRegistryDelta(delta: RegistryDelta, name: string): RegistryDelta {
  const added = delta.added[name];
  const removed = delta.removed[name];
  return {
    added: added !== undefined ? { [name]: added } : {},
    removed: removed !== undefined ? { [name]: removed } : {},
    newRegistries: delta.newRegistries.filter((entry) => entry === name),
    removedRegistries: delta.removedRegistries.filter((entry) => entry === name),
    summary: {
      registriesChanged: added !== undefined || removed !== undefined ? 1 : 0,
      totalAdded: added?.length ?? 0,
      totalRemoved: removed?.length ?? 0
    }
  };
}

function isEmptyRegistryDelta(delta: RegistryDelta): boolean {
  return (
    Object.keys(delta.added).length === 0 &&
    Object.keys(delta.removed).length === 0 &&
    delta.newRegistries.length === 0 &&
    delta.removedRegistries.length === 0
  );
}

/** Added and removed entry counts per changed registry, by registry name. */
function changedRegistries(delta: RegistryDelta): Record<string, { added: number; removed: number }> {
  const names = [...new Set([...Object.keys(delta.added), ...Object.keys(delta.removed)])].sort();
  return Object.fromEntries(
    names.map((name) => [name, { added: delta.added[name]?.length ?? 0, removed: delta.removed[name]?.length ?? 0 }])
  );
}

function atLeast(detail: DetailLevel, level: DetailLevel): boolean {
  const order: readonly DetailLevel[] = ["summary", "standard", "full"];
  return order.indexOf(detail) >= order.indexOf(level);
}

export const versionCompareSpec: CatalogToolSpec<VersionCompareInput> = {
  name: "version-compare",
  description:
    "Compare two Minecraft versions: added and removed classes, registry entries and, with withLibraries, " +
    "libraries. Answers with counts unless detail asks for lists (standard: class and library names; full: also " +
    "registry entries). status: ok, partial (a part failed), not_found (no such registry). " +
    'Example: {"fromVersion":"1.21.1","toVersion":"1.21.10","packageFilter":"net.minecraft.world.item"}',
  annotations: { readOnlyHint: true },
  inputSchema: versionCompareInput,
  examples: [
    { fromVersion: "1.21.1", toVersion: "1.21.10", packageFilter: "net.minecraft.world.item" },
    { fromVersion: "1.21.1", toVersion: "1.21.10", category: "classes", detail: "standard", limit: 100 },
    { fromVersion: "1.21.1", toVersion: "1.21.10", category: "registry", registry: "block", detail: "full" },
    { fromVersion: "1.21.10", toVersion: "26.1", withLibraries: true }
  ],
  statuses: ["ok", "partial", "not_found"],
  primaryKey: "comparison",
  detailProjection: { default: "summary", minimumLevel: {} },
  handler: async (input, call) => {
    const detail = input.detail;
    const registryName = input.registry === undefined ? undefined : normalizeRegistryName(input.registry);
    const warnings: Array<string | CatalogWarning> = [];
    const truncation: CatalogTruncation[] = [];
    let status: CatalogStatus = "ok";

    const output = await call.services.compareVersions({
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      category: input.category,
      maxClassResults: input.limit,
      ...defined({ packageFilter: input.packageFilter })
    });
    // The libraries are read after the comparison, as migration-overview reads
    // them: when the comparison had to download a version's document, the
    // library lists then come from memory instead of a second download that
    // races the first under the deadline. A library failure or a fetch past the
    // deadline leaves the class and registry answer standing; the deadline
    // keeps an unreachable network from holding the heavy-tool gate for the
    // whole fetch timeout.
    const libraryOutcome: LibraryDiffResult | { failure: string } | undefined = input.withLibraries
      ? await withDeadline(
          Promise.all([
            call.services.getVersionLibraries(input.fromVersion),
            call.services.getVersionLibraries(input.toVersion)
          ]),
          LIBRARY_DEADLINE_MS
        ).then(
          ([from, to]) => diffLibraries(from, to),
          (caught: unknown) => ({
            failure:
              caught instanceof DeadlineExceededError
                ? `Library comparison between ${input.fromVersion} and ${input.toVersion} timed out after ${caught.ms}ms.`
                : `Could not compare libraries between ${input.fromVersion} and ${input.toVersion}: ${errorMessage(caught)}`
          })
        )
      : undefined;
    const libraries = libraryOutcome !== undefined && !("failure" in libraryOutcome) ? libraryOutcome : undefined;

    for (const warning of output.warnings) {
      if (CLASS_LIST_CUT_SENTENCE.test(warning)) {
        // The cut matters only where the lists are returned.
        if (detail !== "summary") warnings.push(warning);
      } else if (REGISTRY_FAILED_SENTENCE.test(warning)) {
        status = "partial";
        warnings.push({ code: "registry-unavailable", severity: "warning", message: warning });
      } else {
        warnings.push(warning);
      }
    }
    if (libraryOutcome !== undefined && "failure" in libraryOutcome) {
      status = "partial";
      warnings.push({
        code: "libraries-unavailable",
        severity: "warning",
        message: libraryOutcome.failure
      });
    }

    const comparison: Record<string, unknown> = {
      fromVersion: output.fromVersion,
      toVersion: output.toVersion
    };
    let namesToList = false;
    let registryEntriesToList = false;

    if (output.classes !== undefined) {
      const classes = output.classes;
      const listed = detail !== "summary";
      comparison.classes = {
        addedCount: classes.addedCount,
        removedCount: classes.removedCount,
        unchanged: classes.unchanged,
        mappingApplied: classes.namespace,
        ...(classes.packageFilter !== undefined
          ? {
              packageFilter: {
                value: classes.packageFilter.value,
                matchedFrom: classes.packageFilter.matchedFrom,
                matchedTo: classes.packageFilter.matchedTo
              }
            }
          : {}),
        ...(listed ? { added: classes.added, removed: classes.removed } : {})
      };
      namesToList ||= classes.added.length > 0 || classes.removed.length > 0;
      if (listed && classes.addedCount > classes.added.length) {
        truncation.push({ field: "comparison.classes.added", limitedBy: "limit" });
      }
      if (listed && classes.removedCount > classes.removed.length) {
        truncation.push({ field: "comparison.classes.removed", limitedBy: "limit" });
      }
    }

    if (output.registry !== undefined) {
      const delta = registryName === undefined ? output.registry : narrowRegistryDelta(output.registry, registryName);
      if (registryName !== undefined && isEmptyRegistryDelta(delta)) {
        // The comparison lists only registries that changed, so an empty delta
        // does not tell an unchanged registry from one that does not exist.
        const [from, to] = await Promise.all([
          call.services.getRegistryData({ version: output.fromVersion, includeData: false }),
          call.services.getRegistryData({ version: output.toVersion, includeData: false })
        ]);
        const exists = [from, to].some((listing) => listing.registries?.includes(registryName) === true);
        if (!exists) {
          status = "not_found";
          warnings.push({
            code: "registry-not-found",
            severity: "warning",
            message:
              `Registry "${registryName}" exists in neither ${output.fromVersion} nor ${output.toVersion}; ` +
              "registry-read without registry lists the registry names."
          });
        }
      }
      registryEntriesToList = Object.keys(delta.added).length > 0 || Object.keys(delta.removed).length > 0;
      comparison.registry = {
        ...defined({ name: registryName }),
        summary: delta.summary,
        newRegistries: delta.newRegistries,
        removedRegistries: delta.removedRegistries,
        changed: changedRegistries(delta),
        ...(atLeast(detail, "full") ? { added: delta.added, removed: delta.removed } : {})
      };
    }

    if (libraries !== undefined) {
      comparison.libraries = {
        addedCount: libraries.addedCount,
        removedCount: libraries.removedCount,
        versionChangedCount: libraries.versionChangedCount,
        ...(detail !== "summary" ? { added: libraries.added, removed: libraries.removed } : {})
      };
      namesToList ||= libraries.added.length > 0 || libraries.removed.length > 0;
    }

    // One follow-up: the registry names after an unknown registry, otherwise
    // the lowest detail level that adds a non-empty list.
    const nextLevel: DetailLevel | undefined =
      detail !== "summary" ? undefined : namesToList ? "standard" : registryEntriesToList ? "full" : undefined;
    const nextActions: CatalogNextAction[] =
      status === "not_found"
        ? [
            {
              tool: "registry-read",
              params: { version: output.toVersion },
              reason: "List the registry names."
            }
          ]
        : nextLevel !== undefined
          ? [
              {
                tool: "version-compare",
                params: {
                  fromVersion: input.fromVersion,
                  toVersion: input.toVersion,
                  ...defined({
                    category: input.category === "all" ? undefined : input.category,
                    packageFilter: input.packageFilter,
                    registry: input.registry,
                    limit: input.limit === 500 ? undefined : input.limit,
                    withLibraries: input.withLibraries ? true : undefined
                  }),
                  detail: nextLevel
                },
                reason: nextLevel === "standard" ? "List the added and removed names." : "List the added and removed registry entries."
              }
            ]
          : [];

    return {
      result: { comparison: { ...comparison, status } },
      warnings,
      nextActions,
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// class-diff
// ---------------------------------------------------------------------------

const classDiffInput = z
  .strictObject({
    className: nonEmptyString.describe("Fully qualified class name in mapping's namespace."),
    fromVersion: nonEmptyString.describe('Older Minecraft version, e.g. "1.21.1".'),
    toVersion: nonEmptyString.describe('Newer Minecraft version, e.g. "1.21.10".'),
    mapping: mappingSchema.describe("Namespace of className and of the member names returned."),
    detail: detailSchema("full").describe("summary: counts; standard: member deltas; full: adds before/after members.")
  })
  .superRefine((value, ctx) => {
    // Only obfuscated names sit in the default package. A name without a
    // package in another namespace can never be mapped, and the mapping
    // lookup's refusal would otherwise read as mapping data that failed to
    // load (`unavailable`).
    if (value.mapping !== "obfuscated" && !value.className.includes(".")) {
      ctx.addIssue({
        code: "custom",
        path: ["className"],
        message: `"className" must be a fully qualified class name with its package in mapping "${value.mapping}", e.g. "net.minecraft.world.item.Item".`
      });
    }
  });

type ClassDiffInput = z.output<typeof classDiffInput>;

/**
 * The class-source service's sentences for a class name it could not map to
 * the jars' names; it then looks the name up as given (src/source/class-source.ts).
 */
function unmappedClassSentences(className: string): RegExp[] {
  const name = escapeRegExp(className.trim());
  return [
    new RegExp(`^Could not map class "${name}" from \\S+ to \\S+ for .+?(?: because version is unavailable)?\\.$`),
    new RegExp(`^Mapping lookup failed for class "${name}" while preparing .+ in \\S+\\.$`)
  ];
}

/**
 * The namespace the class-signature service maps a class name into before it
 * reads the class from a version's jar (src/source/lifecycle/mapping-helpers.ts).
 */
const JAR_NAMESPACE = "obfuscated";

/** The versions in which the service did not find the class. */
function versionsWithoutClass(output: DiffClassSignaturesOutput): string[] {
  const { fromVersion, toVersion } = output.query;
  switch (output.classChange) {
    case "added":
      return [fromVersion];
    case "removed":
      return [toVersion];
    case "absent_in_both":
      return [...new Set([fromVersion, toVersion])];
    default:
      return [];
  }
}

/**
 * A class missing from a version's jar is a real absence only when that
 * version's mapping data answered. The service writes the same unmapped-class
 * sentence, naming no version, both for a class the mapping data does not
 * hold and for mapping data that could not be loaded, and then looks the name
 * up unmapped. So when it wrote one, the class name is looked up again in the
 * mapping data of each version without the class: `mapping_unavailable` or a
 * failed lookup makes the diff `unavailable`, since the class may exist there.
 * A version whose jar already uses the names of `mapping` (a Mojang name on an
 * unobfuscated runtime) was read without a mapping, so its absence stands.
 */
async function classDiffStatus(
  services: CatalogServices,
  output: DiffClassSignaturesOutput,
  mapping: SourceMapping
): Promise<CatalogStatus> {
  const absentIn = versionsWithoutClass(output);
  if (absentIn.length === 0) return "ok";
  const answered: CatalogStatus = output.classChange === "absent_in_both" ? "not_found" : "ok";
  const unmapped = unmappedClassSentences(output.query.className);
  if (!output.warnings.some((warning) => unmapped.some((pattern) => pattern.test(warning)))) return answered;
  for (const version of absentIn) {
    if (isUnobfuscatedIdentityPair(version, mapping, JAR_NAMESPACE)) continue;
    try {
      const lookup = await services.findMapping({
        version,
        kind: "class",
        name: output.query.className,
        sourceMapping: mapping,
        targetMapping: JAR_NAMESPACE
      });
      if (lookup.status === "mapping_unavailable") return "unavailable";
    } catch {
      return "unavailable";
    }
  }
  return answered;
}

export const classDiffSpec: CatalogToolSpec<ClassDiffInput> = {
  name: "class-diff",
  description:
    "Diff one class between two Minecraft versions: added, removed and modified constructors, methods and " +
    "fields. mapping (required) is the namespace of className and the returned names. status: ok, not_found " +
    "(in neither version), unavailable (mapping data could not be loaded). " +
    'Example: {"className":"net.minecraft.world.item.Item","fromVersion":"1.21.1","toVersion":"1.21.10","mapping":"mojang"}',
  annotations: { readOnlyHint: true },
  inputSchema: classDiffInput,
  examples: [
    { className: "net.minecraft.world.item.Item", fromVersion: "1.21.1", toVersion: "1.21.10", mapping: "mojang" },
    { className: "net.minecraft.class_1792", fromVersion: "1.21.1", toVersion: "1.21.10", mapping: "intermediary", detail: "summary" }
  ],
  statuses: ["ok", "not_found", "unavailable"],
  primaryKey: "diff",
  detailProjection: {
    default: "full",
    minimumLevel: { constructors: "standard", methods: "standard", fields: "standard" }
  },
  handler: async (input, call) => {
    const output = await call.services.diffClassSignatures({
      className: input.className,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      mapping: input.mapping,
      includeFullDiff: input.detail === "full"
    });
    return {
      result: {
        diff: {
          className: output.query.className,
          fromVersion: output.query.fromVersion,
          toVersion: output.query.toVersion,
          mappingApplied: output.query.mapping,
          classChange: output.classChange,
          status: await classDiffStatus(call.services, output, input.mapping),
          summary: output.summary,
          constructors: output.constructors,
          methods: output.methods,
          fields: output.fields
        }
      },
      warnings: output.warnings
    };
  }
};

// ---------------------------------------------------------------------------
// registry-read
// ---------------------------------------------------------------------------

const registryReadInput = z.strictObject({
  version: nonEmptyString.describe('Minecraft version, e.g. "1.21.10".'),
  registry: nonEmptyString.optional().describe('One registry, e.g. "block" or "minecraft:item"; default all.'),
  withData: z.boolean().default(false).describe("Add each registry's entries and default entry."),
  limit: numericInput(z.number().int().min(1)).optional().describe("Entries per registry with withData; default all.")
});

type RegistryReadInput = z.output<typeof registryReadInput>;

type RegistryListing = {
  name: string;
  entryCount: number;
  default?: string;
  entries?: RegistryData["entries"];
};

export const registryReadSpec: CatalogToolSpec<RegistryReadInput> = {
  name: "registry-read",
  description:
    "Read a Minecraft version's generated registries (block, item, ...): names and entry counts, plus each " +
    "registry's entries with withData. The first read of a version downloads its server jar and runs the game's " +
    "data generator (needs Java). " +
    'Example: {"version":"1.21.10","registry":"block","withData":true,"limit":50}',
  annotations: { readOnlyHint: true },
  inputSchema: registryReadInput,
  examples: [
    { version: "1.21.10" },
    { version: "1.21.10", registry: "block", withData: true, limit: 50 }
  ],
  statuses: ["ok"],
  primaryKey: "registries",
  handler: async (input, call) => {
    const output = await call.services.getRegistryData({
      version: input.version,
      includeData: input.withData,
      ...defined({ registry: input.registry, maxEntriesPerRegistry: input.limit })
    });
    const listing = (name: string, entryCount: number, data: RegistryData | undefined): RegistryListing => ({
      name,
      entryCount,
      ...(input.withData && data !== undefined ? { ...defined({ default: data.default }), entries: data.entries } : {})
    });
    const registries: RegistryListing[] =
      output.registry !== undefined
        ? [listing(output.registry, output.entryCount, output.data as RegistryData | undefined)]
        : (output.registries ?? []).map((name) =>
            listing(
              name,
              output.registryEntryCounts?.[name] ?? 0,
              (output.data as Record<string, RegistryData> | undefined)?.[name]
            )
          );
    const truncation: CatalogTruncation[] = [];
    registries.forEach((registry, index) => {
      if (registry.entries !== undefined && Object.keys(registry.entries).length < registry.entryCount) {
        truncation.push({ field: `registries[${index}].entries`, limitedBy: "limit" });
      }
    });
    const nextActions: CatalogNextAction[] =
      input.registry !== undefined && !input.withData
        ? [
            {
              tool: "registry-read",
              params: { version: input.version, registry: input.registry, withData: true, ...defined({ limit: input.limit }) },
              reason: "Read this registry's entries."
            }
          ]
        : [];
    return {
      result: { registries, version: output.version },
      warnings: output.warnings,
      nextActions,
      truncation
    };
  }
};

export const COMPARISON_TOOL_SPECS: readonly CatalogToolSpec[] = [versionCompareSpec, classDiffSpec, registryReadSpec];
