import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { AppError, ERROR_CODES } from "./errors.js";
import { normalizeJarPath } from "./path-resolver.js";
import { listJarEntries, readJarEntryAsUtf8 } from "./source-jar-reader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModLoader = "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
export type ModJarKind = "binary" | "source" | "mixed";

export interface ModDependency {
  modId: string;
  versionRange?: string;
  kind: "required" | "optional" | "recommends" | "conflicts";
}

export interface ModAnalysisResult {
  loader: ModLoader;
  jarKind: ModJarKind;
  modId?: string;
  modName?: string;
  modVersion?: string;
  description?: string;
  entrypoints?: Record<string, string[]>;
  mixinConfigs?: string[];
  accessWidener?: string;
  dependencies?: ModDependency[];
  classCount: number;
  classes?: string[];
}

export interface AnalyzeModOptions {
  includeClasses?: boolean;
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Zod schemas — .passthrough() for lenient parsing
// ---------------------------------------------------------------------------

const stringOrEntrypoint = z.union([
  z.string(),
  z.object({ value: z.string() }).passthrough()
]);

const stringOrMixinRef = z.union([
  z.string(),
  z.object({ config: z.string() }).passthrough()
]);

const fabricModJsonSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    entrypoints: z.record(z.array(stringOrEntrypoint)).optional(),
    mixins: z.array(stringOrMixinRef).optional(),
    accessWidener: z.string().optional(),
    depends: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    recommends: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    conflicts: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    suggests: z.record(z.union([z.string(), z.array(z.string())])).optional()
  })
  .passthrough();

const quiltModJsonSchema = z
  .object({
    schema_version: z.number().optional(),
    quilt_loader: z
      .object({
        id: z.string().optional(),
        version: z.string().optional(),
        metadata: z
          .object({
            name: z.string().optional(),
            description: z.string().optional()
          })
          .passthrough()
          .optional(),
        entrypoints: z.record(z.array(stringOrEntrypoint)).optional(),
        depends: z.array(z.unknown()).optional()
      })
      .passthrough()
      .optional(),
    mixin: z.union([z.string(), z.array(z.string())]).optional(),
    access_widener: z.string().optional()
  })
  .passthrough();

const forgeModsTomlSchema = z
  .object({
    modLoader: z.string().optional(),
    mods: z
      .array(
        z
          .object({
            modId: z.string().optional(),
            displayName: z.string().optional(),
            version: z.string().optional(),
            description: z.string().optional()
          })
          .passthrough()
      )
      .optional(),
    dependencies: z.record(z.array(z.unknown())).optional(),
    mixins: z.array(z.object({ config: z.string() }).passthrough()).optional()
  })
  .passthrough();

const legacyForgeSchema = z.array(
  z
    .object({
      modid: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      description: z.string().optional()
    })
    .passthrough()
);

// ---------------------------------------------------------------------------
// Parser: Fabric
// ---------------------------------------------------------------------------

function normalizeFabricEntrypoint(v: string | { value: string }): string {
  return typeof v === "string" ? v : v.value;
}

function normalizeMixinRef(v: string | { config: string }): string {
  return typeof v === "string" ? v : v.config;
}

function collectFabricDeps(
  record: Record<string, string | string[]> | undefined,
  kind: ModDependency["kind"]
): ModDependency[] {
  if (!record) return [];
  return Object.entries(record).map(([modId, versionRange]) => ({
    modId,
    versionRange: Array.isArray(versionRange) ? versionRange.join(" || ") : versionRange,
    kind
  }));
}

function parseFabricMod(content: string): Partial<ModAnalysisResult> {
  const parsed = fabricModJsonSchema.safeParse(JSON.parse(content));
  if (!parsed.success) return {};
  const mod = parsed.data;

  const entrypoints: Record<string, string[]> | undefined = mod.entrypoints
    ? Object.fromEntries(
        Object.entries(mod.entrypoints).map(([key, values]) => [
          key,
          values.map(normalizeFabricEntrypoint)
        ])
      )
    : undefined;

  const mixinConfigs = mod.mixins?.map(normalizeMixinRef);

  const dependencies = [
    ...collectFabricDeps(mod.depends, "required"),
    ...collectFabricDeps(mod.recommends, "recommends"),
    ...collectFabricDeps(mod.conflicts, "conflicts"),
    ...collectFabricDeps(mod.suggests, "optional")
  ];

  return {
    modId: mod.id,
    modName: mod.name,
    modVersion: mod.version,
    description: mod.description,
    entrypoints,
    mixinConfigs,
    accessWidener: mod.accessWidener,
    dependencies: dependencies.length > 0 ? dependencies : undefined
  };
}

// ---------------------------------------------------------------------------
// Parser: Quilt
// ---------------------------------------------------------------------------

function parseQuiltMod(content: string): Partial<ModAnalysisResult> {
  const parsed = quiltModJsonSchema.safeParse(JSON.parse(content));
  if (!parsed.success) return {};
  const mod = parsed.data;
  const loader = mod.quilt_loader;

  const entrypoints: Record<string, string[]> | undefined = loader?.entrypoints
    ? Object.fromEntries(
        Object.entries(loader.entrypoints).map(([key, values]) => [
          key,
          values.map(normalizeFabricEntrypoint)
        ])
      )
    : undefined;

  const rawMixin = mod.mixin;
  const mixinConfigs = rawMixin
    ? Array.isArray(rawMixin)
      ? rawMixin
      : [rawMixin]
    : undefined;

  const dependencies: ModDependency[] = [];
  if (loader?.depends && Array.isArray(loader.depends)) {
    for (const dep of loader.depends) {
      if (typeof dep === "string") {
        dependencies.push({ modId: dep, kind: "required" });
      } else if (dep && typeof dep === "object" && "id" in dep) {
        const d = dep as { id: string; versions?: string; optional?: boolean };
        dependencies.push({
          modId: d.id,
          versionRange: d.versions,
          kind: d.optional ? "optional" : "required"
        });
      }
    }
  }

  return {
    modId: loader?.id,
    modName: loader?.metadata?.name,
    modVersion: loader?.version,
    description: loader?.metadata?.description,
    entrypoints,
    mixinConfigs,
    accessWidener: mod.access_widener,
    dependencies: dependencies.length > 0 ? dependencies : undefined
  };
}

// ---------------------------------------------------------------------------
// Parser: Forge / NeoForge (TOML)
// ---------------------------------------------------------------------------

function parseForgeMod(
  content: string,
  entries: string[]
): Partial<ModAnalysisResult> & { detectedLoader?: ModLoader } {
  const raw = parseToml(content);
  const parsed = forgeModsTomlSchema.safeParse(raw);
  if (!parsed.success) return {};
  const toml = parsed.data;

  const firstMod = toml.mods?.[0];

  // Determine Forge vs NeoForge from modLoader field
  const modLoaderValue = toml.modLoader?.toLowerCase() ?? "";
  const isNeoForge =
    modLoaderValue.includes("neoforge") || modLoaderValue.includes("lowcodefml");

  // Also check for neoforge.mods.toml presence
  const hasNeoforgeToml = entries.includes("META-INF/neoforge.mods.toml");

  const detectedLoader: ModLoader = isNeoForge || hasNeoforgeToml ? "neoforge" : "forge";

  // Dependencies
  const dependencies: ModDependency[] = [];
  if (toml.dependencies) {
    for (const depArray of Object.values(toml.dependencies)) {
      for (const dep of depArray) {
        if (dep && typeof dep === "object") {
          const d = dep as { modId?: string; mandatory?: boolean; versionRange?: string };
          if (d.modId) {
            dependencies.push({
              modId: d.modId,
              versionRange: d.versionRange,
              kind: d.mandatory === false ? "optional" : "required"
            });
          }
        }
      }
    }
  }

  // Mixin configs
  const mixinConfigs = toml.mixins?.map((m) => m.config);

  return {
    detectedLoader,
    modId: firstMod?.modId,
    modName: firstMod?.displayName,
    modVersion: firstMod?.version,
    description: firstMod?.description,
    mixinConfigs: mixinConfigs && mixinConfigs.length > 0 ? mixinConfigs : undefined,
    dependencies: dependencies.length > 0 ? dependencies : undefined
  };
}

// ---------------------------------------------------------------------------
// Parser: Legacy Forge (mcmod.info)
// ---------------------------------------------------------------------------

function parseLegacyForgeMod(content: string): Partial<ModAnalysisResult> {
  // mcmod.info may be wrapped in an extra array or be a direct array
  let rawArray: unknown = JSON.parse(content);
  if (Array.isArray(rawArray) && rawArray.length === 1 && Array.isArray(rawArray[0])) {
    rawArray = rawArray[0];
  }

  const parsed = legacyForgeSchema.safeParse(rawArray);
  if (!parsed.success) return {};

  const first = parsed.data[0];
  if (!first) return {};

  return {
    modId: first.modid,
    modName: first.name,
    modVersion: first.version,
    description: first.description
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function analyzeModJar(
  jarPath: string,
  options?: AnalyzeModOptions
): Promise<ModAnalysisResult> {
  let resolvedPath: string;
  try {
    resolvedPath = normalizeJarPath(jarPath);
  } catch (cause) {
    throw new AppError({
      code: ERROR_CODES.INVALID_INPUT,
      message: cause instanceof Error ? cause.message : `Invalid jar path: ${jarPath}`,
      details: { jarPath }
    });
  }

  let entries: string[];
  try {
    entries = await listJarEntries(resolvedPath);
  } catch (cause) {
    throw new AppError({
      code: ERROR_CODES.SOURCE_NOT_FOUND,
      message: `Failed to read jar "${resolvedPath}".`,
      details: {
        jarPath: resolvedPath,
        reason: toErrorMessage(cause)
      }
    });
  }

  // Class counting
  const classEntries = entries.filter((e) => e.endsWith(".class"));
  const javaEntries = entries.filter((e) => e.endsWith(".java"));
  const classCount = classEntries.length;
  const classes = options?.includeClasses ? classEntries : undefined;
  const jarKind: ModJarKind =
    classEntries.length > 0 && javaEntries.length > 0
      ? "mixed"
      : javaEntries.length > 0
        ? "source"
        : "binary";

  // Detect loader and parse metadata
  let loader: ModLoader = "unknown";
  let metadata: Partial<ModAnalysisResult> = {};

  if (entries.includes("fabric.mod.json")) {
    loader = "fabric";
    try {
      const content = await readJarEntryAsUtf8(resolvedPath, "fabric.mod.json");
      metadata = parseFabricMod(content);
    } catch {
      // graceful fallback
    }
  } else if (entries.includes("quilt.mod.json")) {
    loader = "quilt";
    try {
      const content = await readJarEntryAsUtf8(resolvedPath, "quilt.mod.json");
      metadata = parseQuiltMod(content);
    } catch {
      // graceful fallback
    }
  } else if (entries.includes("META-INF/neoforge.mods.toml")) {
    loader = "neoforge";
    try {
      const content = await readJarEntryAsUtf8(resolvedPath, "META-INF/neoforge.mods.toml");
      const result = parseForgeMod(content, entries);
      const { detectedLoader: _, ...rest } = result;
      metadata = rest;
    } catch {
      // graceful fallback
    }
  } else if (entries.includes("META-INF/mods.toml")) {
    try {
      const content = await readJarEntryAsUtf8(resolvedPath, "META-INF/mods.toml");
      const result = parseForgeMod(content, entries);
      loader = result.detectedLoader ?? "forge";
      const { detectedLoader: _, ...rest } = result;
      metadata = rest;
    } catch {
      loader = "forge";
    }
  } else if (entries.includes("mcmod.info")) {
    loader = "forge";
    try {
      const content = await readJarEntryAsUtf8(resolvedPath, "mcmod.info");
      metadata = parseLegacyForgeMod(content);
    } catch {
      // graceful fallback
    }
  }

  return {
    loader,
    jarKind,
    ...metadata,
    classCount,
    ...(classes !== undefined ? { classes } : {})
  };
}
