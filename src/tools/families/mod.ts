import { existsSync, statSync } from "node:fs";

import { z } from "zod";

import { createError, ERROR_CODES, isAppError } from "../../errors.js";
import { analyzeModJar, type ModLoader } from "../../mod-analyzer.js";
import { extractMinecraftVersion, remapModJar, resolveOutputJarPath } from "../../mod-remap-service.js";
import { normalizePathForHost } from "../../path-converter.js";
import { defined } from "../items.js";
import { nonEmptyString, numericInput } from "../schemas.js";
import type { CatalogNextAction, CatalogToolSpec, CatalogTruncation, CatalogWarning } from "../types.js";

/**
 * Mod family: what a mod jar declares, a text search over its source, and
 * remapping a Fabric or Quilt jar to readable names. A mod's classes are read
 * with `source-read` and `member-list` through `target: { kind: "jar", jarPath }`.
 */

// ---------------------------------------------------------------------------
// mod-inspect
// ---------------------------------------------------------------------------

const modInspectInput = z.strictObject({
  jarPath: nonEmptyString.describe("Path to the mod jar."),
  withClasses: z.boolean().default(false).describe("Add each .class entry's path with / as ., e.g. com.example.Foo$Bar.")
});

type ModInspectInput = z.output<typeof modInspectInput>;

/**
 * A `.class` jar entry's path with `/` as `.`: `com/example/Foo$Bar.class` →
 * `com.example.Foo$Bar`, the binary class name of an ordinary class. Entries
 * such as `module-info.class`, `package-info.class` and multi-release
 * `META-INF/versions/<n>/…` copies are listed the same way.
 */
export function classNameOfEntry(entry: string): string {
  return entry.replace(/\.class$/, "").replaceAll("/", ".");
}

export const modInspectSpec: CatalogToolSpec<ModInspectInput> = {
  name: "mod-inspect",
  description:
    "Read a mod jar's metadata: loader, id, name, version, entrypoints, mixins, access wideners and " +
    "transformers, dependencies, nested jars, class count. withClasses adds each .class entry path with / as . " +
    "(a class name except module-info, package-info, META-INF/versions/...) for source-read or member-list with " +
    'target {"kind":"jar","jarPath":...}. Example: {"jarPath":"/mods/a.jar","withClasses":true}',
  annotations: { readOnlyHint: true },
  inputSchema: modInspectInput,
  examples: [{ jarPath: "/mods/example-1.0.0.jar" }, { jarPath: "/mods/example-1.0.0.jar", withClasses: true }],
  statuses: ["ok"],
  primaryKey: "mod",
  handler: async (input) => {
    const { classes, ...analysis } = await analyzeModJar(input.jarPath, { includeClasses: input.withClasses });
    return {
      result: {
        mod: {
          ...analysis,
          ...(classes !== undefined ? { classes: classes.map(classNameOfEntry) } : {})
        }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// mod-search
// ---------------------------------------------------------------------------

const MOD_SEARCH_TYPES = ["class", "method", "field", "content", "all"] as const;

const modSearchInput = z.strictObject({
  jarPath: nonEmptyString.describe("Path to the mod jar, binary or sources."),
  query: nonEmptyString
    .max(200)
    .describe("Regular expression, else literal text; case-insensitive; 1-200 characters."),
  searchType: z
    .enum(MOD_SEARCH_TYPES)
    .default("all")
    .describe("class: class names; method, field: declaration lines; content: other lines; all."),
  limit: numericInput(z.number().int().min(1).max(200)).default(50).describe("Maximum hits, 1-200; default 50.")
});

type ModSearchInput = z.output<typeof modSearchInput>;

export const modSearchSpec: CatalogToolSpec<ModSearchInput> = {
  name: "mod-search",
  description:
    "Search a mod jar's Java source with a case-insensitive regular expression (else literal text): class names, " +
    "method and field declaration lines, other lines. A sources jar is read directly; a binary jar is decompiled " +
    "first (cached; needs Java). Hits: {type, name, file, line?, context?}. " +
    'Example: {"jarPath":"/mods/example-1.0.0.jar","query":"onInitialize","searchType":"method"}',
  annotations: { readOnlyHint: true },
  inputSchema: modSearchInput,
  examples: [
    { jarPath: "/mods/example-1.0.0.jar", query: "onInitialize", searchType: "method" },
    { jarPath: "/mods/example-1.0.0-sources.jar", query: "Registry\\.register", limit: 20 }
  ],
  statuses: ["ok"],
  primaryKey: "hits",
  handler: async (input, call) => {
    const output = await call.services.searchModSource({
      jarPath: input.jarPath,
      query: input.query,
      searchType: input.searchType,
      limit: input.limit
    });
    const truncation: CatalogTruncation[] = output.truncated ? [{ field: "hits", limitedBy: "limit" }] : [];
    return { result: { hits: output.hits }, warnings: output.warnings, truncation };
  }
};

// ---------------------------------------------------------------------------
// mod-remap
// ---------------------------------------------------------------------------

const REMAP_TARGETS = ["yarn", "mojang"] as const;

const modRemapInput = z.strictObject({
  jarPath: nonEmptyString.describe("Path to the Fabric or Quilt mod jar."),
  toMapping: z.enum(REMAP_TARGETS).describe("Namespace to remap into."),
  outputJar: nonEmptyString
    .optional()
    .describe("Output path; default <modId>-<modVersion>-<toMapping>.jar beside jarPath."),
  version: nonEmptyString.optional().describe("Minecraft version; default read from the mod's minecraft dependency."),
  force: z.boolean().default(false).describe("Rebuild ignoring the remap cache; refresh Yarn build metadata."),
  apply: z.boolean().default(false).describe("Write outputJar, replacing an existing file; default only previews.")
});

type ModRemapInput = z.output<typeof modRemapInput>;

/**
 * The remap service's refusals of a loader it cannot remap (only Fabric and
 * Quilt jars are supported), raised before anything is read or written.
 */
function assertRemappableLoader(loader: ModLoader, jarPath: string): void {
  if (loader === "unknown") {
    throw createError({
      code: ERROR_CODES.REMAP_FAILED,
      message: "Could not detect mod loader. Only Fabric and Quilt mods are supported.",
      details: { jarPath }
    });
  }
  if (loader !== "fabric" && loader !== "quilt") {
    throw createError({
      code: ERROR_CODES.REMAP_FAILED,
      message: `Unsupported mod loader for remapping: "${loader}". Only Fabric and Quilt mods are supported.`,
      details: { loader }
    });
  }
}

/**
 * Whether `outputJar` names the existing file `jarPath`: the same device and
 * inode, however the path is spelled (a link, `..` through a linked directory,
 * a case variant on a case-insensitive file system). A path that does not
 * exist cannot be the input.
 */
function isSameFile(outputJar: string, jarPath: string): boolean {
  const output = statSync(outputJar, { bigint: true, throwIfNoEntry: false });
  if (output === undefined) return false;
  const input = statSync(jarPath, { bigint: true });
  return output.dev === input.dev && output.ino === input.ino;
}

/** The remap service's hint for a Mojang-named jar remapped to yarn, which names the 8.x input. */
const MOJANG_TO_YARN_HINT =
  'Use targetMapping="mojang" for Mojang-mapped inputs, or rebuild the mod against intermediary mappings before requesting yarn output.';
const MOJANG_TO_YARN_CATALOG_HINT =
  'Use toMapping: "mojang" for Mojang-mapped inputs, or rebuild the mod against intermediary mappings before requesting yarn output.';

/** The remap service's refusal of a Mojang-named jar with its hint worded for `mod-remap`; other errors pass. */
function catalogRemapError(caught: unknown): unknown {
  if (
    !isAppError(caught) ||
    caught.code !== ERROR_CODES.REMAP_FAILED ||
    caught.details?.nextAction !== MOJANG_TO_YARN_HINT
  ) {
    return caught;
  }
  return createError({
    code: caught.code,
    message: caught.message,
    details: { ...caught.details, nextAction: MOJANG_TO_YARN_CATALOG_HINT }
  });
}

/** The remap service's notice for a result copied from its remap cache. */
const CACHE_HIT_NOTICE = "Result served from cache.";

function invalidField(path: string, message: string): Error {
  return createError({
    code: ERROR_CODES.INVALID_INPUT,
    message,
    details: { fieldErrors: [{ path, code: "custom", message }] }
  });
}

export const modRemapSpec: CatalogToolSpec<ModRemapInput> = {
  name: "mod-remap",
  description:
    "Remap a Fabric or Quilt mod jar to yarn or mojang names. Previews unless apply is true: the preview writes " +
    "nothing and reports outputJar and outputExists; apply writes outputJar, replacing an existing file (a remap " +
    "needs Java and downloads mappings). An outputJar equal to jarPath is rejected. " +
    'Example: {"jarPath":"/mods/example-1.0.0.jar","toMapping":"mojang"}',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: modRemapInput,
  examples: [
    { jarPath: "/mods/example-1.0.0.jar", toMapping: "mojang" },
    {
      jarPath: "/mods/example-1.0.0.jar",
      toMapping: "yarn",
      outputJar: "/mods/remapped/example-yarn.jar",
      version: "1.21.10",
      apply: true
    }
  ],
  statuses: ["ok"],
  primaryKey: "remap",
  handler: async (input, call) => {
    // The same normalization and checks the remap service applies to its input jar.
    const jarPath = normalizePathForHost(input.jarPath, undefined, "jarPath");
    if (!jarPath.toLowerCase().endsWith(".jar")) {
      throw invalidField("jarPath", "jarPath must point to a .jar file.");
    }
    if (!existsSync(jarPath)) {
      throw createError({
        code: ERROR_CODES.JAR_NOT_FOUND,
        message: `Input JAR not found: ${jarPath}`,
        details: { jarPath }
      });
    }

    const analysis = await analyzeModJar(jarPath);
    assertRemappableLoader(analysis.loader, jarPath);
    const version = input.version ?? extractMinecraftVersion(analysis.dependencies);
    const outputJar = resolveOutputJarPath(
      { inputJar: jarPath, outputJar: input.outputJar, targetMapping: input.toMapping },
      jarPath,
      analysis.modId,
      analysis.modVersion
    );
    if (existsSync(outputJar) && statSync(outputJar).isDirectory()) {
      throw invalidField("outputJar", `outputJar ${outputJar} is a directory; pass the path of the jar to write.`);
    }
    if (isSameFile(outputJar, jarPath)) {
      throw invalidField(
        "outputJar",
        `outputJar must differ from jarPath: writing ${outputJar} would replace the input jar. Pass another outputJar.`
      );
    }

    if (!input.apply) {
      const outputExists = existsSync(outputJar);
      const warnings: CatalogWarning[] = [];
      const params = {
        jarPath: input.jarPath,
        toMapping: input.toMapping,
        ...defined({ outputJar: input.outputJar, version: input.version, force: input.force ? true : undefined })
      };
      const nextActions: CatalogNextAction[] = [];
      if (version === undefined) {
        warnings.push({
          code: "version-unresolved",
          severity: "warning",
          message: "The mod's metadata names no Minecraft version; apply needs version."
        });
        nextActions.push({
          tool: "mod-remap",
          params: { ...params, version: "<minecraft-version>", apply: true },
          reason: "Remap with the Minecraft version the mod targets.",
          template: true
        });
      } else {
        nextActions.push({
          tool: "mod-remap",
          params: { ...params, apply: true },
          reason: outputExists ? `Write ${outputJar}, replacing the existing file.` : `Write ${outputJar}.`
        });
      }
      return {
        result: {
          remap: {
            mode: "preview",
            jarPath,
            outputJar,
            outputExists,
            toMapping: input.toMapping,
            loader: analysis.loader,
            ...defined({ modId: analysis.modId, modVersion: analysis.modVersion, version })
          }
        },
        warnings,
        nextActions
      };
    }

    if (version === undefined) {
      throw invalidField("version", "The mod's metadata names no Minecraft version; pass version.");
    }
    let output: Awaited<ReturnType<typeof remapModJar>>;
    try {
      output = await remapModJar(
        {
          inputJar: jarPath,
          outputJar,
          mcVersion: version,
          targetMapping: input.toMapping,
          ...(input.force ? { forceRemap: true } : {})
        },
        call.config
      );
    } catch (caught) {
      throw catalogRemapError(caught);
    }
    return {
      result: {
        remap: {
          mode: "apply",
          outputJar: output.outputJar,
          version: output.mcVersion,
          fromMapping: output.fromMapping,
          toMapping: output.targetMapping,
          resolvedTargetNamespace: output.resolvedTargetNamespace,
          durationMs: output.durationMs,
          ...(output.warnings.includes(CACHE_HIT_NOTICE) ? { fromCache: true } : {})
        }
      },
      warnings: output.warnings
    };
  }
};

export const MOD_TOOL_SPECS: readonly CatalogToolSpec[] = [modInspectSpec, modSearchSpec, modRemapSpec];
