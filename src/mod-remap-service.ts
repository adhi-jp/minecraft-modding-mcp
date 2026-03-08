import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { log } from "./logger.js";
import { resolveTinyMappingFile } from "./mapping-service.js";
import { resolveMojangTinyFile } from "./mojang-tiny-mapping-service.js";
import { analyzeModJar, type ModLoader } from "./mod-analyzer.js";
import { normalizePathForHost } from "./path-converter.js";
import { listJarEntries, readJarEntryAsBuffer } from "./source-jar-reader.js";
import { remapJar } from "./tiny-remapper-service.js";
import { resolveTinyRemapperJar } from "./tiny-remapper-resolver.js";
import type { Config } from "./types.js";

export interface ModRemapInput {
  inputJar: string;
  outputJar?: string;
  mcVersion?: string;
  targetMapping: "yarn" | "mojang";
}

export interface ModRemapResult {
  outputJar: string;
  mcVersion: string;
  fromMapping: string;
  targetMapping: string;
  resolvedTargetNamespace: "yarn" | "mojang";
  durationMs: number;
  warnings: string[];
}

function normalizeTargetNamespace(target: ModRemapInput["targetMapping"]): "yarn" | "mojang" {
  return target === "yarn" ? "yarn" : "mojang";
}

function defaultSourceNamespaceForLoader(loader: ModLoader): "intermediary" {
  if (loader === "fabric" || loader === "quilt") {
    return "intermediary";
  }
  throw createError({
    code: ERROR_CODES.REMAP_FAILED,
    message: `Unsupported mod loader for remapping: "${loader}". Only Fabric and Quilt mods are supported.`,
    details: { loader }
  });
}

function extractMinecraftVersion(
  dependencies: Array<{ modId: string; versionRange?: string }> | undefined
): string | undefined {
  if (!dependencies) {
    return undefined;
  }

  const mcDep = dependencies.find((dep) => dep.modId === "minecraft");
  if (!mcDep?.versionRange) {
    return undefined;
  }

  // Try to extract exact version from ranges like ">=1.20.4", "~1.20.4", "1.20.4", "^1.20.4"
  const match = mcDep.versionRange.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1];
}

function countMatches(input: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let count = 0;
  while (globalPattern.exec(input)) {
    count += 1;
  }
  return count;
}

async function detectFabricLikeInputNamespace(
  inputJar: string
): Promise<{ fromNamespace: "intermediary" | "mojang"; warnings: string[] }> {
  const warnings: string[] = [];
  const classEntries = (await listJarEntries(inputJar))
    .filter((entry) => entry.endsWith(".class"))
    .slice(0, 24);

  if (classEntries.length === 0) {
    warnings.push("Could not inspect class entries to detect input mapping; assuming intermediary.");
    return {
      fromNamespace: "intermediary",
      warnings
    };
  }

  let mojangScore = 0;
  let intermediaryScore = 0;
  for (const entry of classEntries) {
    let text = "";
    try {
      text = (await readJarEntryAsBuffer(inputJar, entry)).toString("latin1");
    } catch {
      continue;
    }
    mojangScore += countMatches(
      text,
      /net\/minecraft\/(?:advancements|client|commands|core|data|gametest|nbt|network|recipe|resources|server|sounds|stats|tags|util|world)\//g
    ) * 3;
    intermediaryScore += countMatches(text, /net\/minecraft\/class_\d+/g) * 3;
    intermediaryScore += countMatches(text, /\b(?:method|field)_\d+\b/g);
  }

  if (mojangScore > intermediaryScore && mojangScore > 0) {
    return {
      fromNamespace: "mojang",
      warnings
    };
  }
  if (intermediaryScore > mojangScore && intermediaryScore > 0) {
    return {
      fromNamespace: "intermediary",
      warnings
    };
  }

  warnings.push(
    "Could not confidently detect whether the input jar uses intermediary or mojang names; assuming intermediary."
  );
  return {
    fromNamespace: "intermediary",
    warnings
  };
}

async function detectInputNamespaceForLoader(
  inputJar: string,
  loader: ModLoader
): Promise<{ fromNamespace: "intermediary" | "mojang"; warnings: string[] }> {
  if (loader === "fabric" || loader === "quilt") {
    return detectFabricLikeInputNamespace(inputJar);
  }
  return {
    fromNamespace: defaultSourceNamespaceForLoader(loader),
    warnings: []
  };
}

function resolveOutputJarPath(
  input: ModRemapInput,
  normalizedInput: string,
  modId: string | undefined,
  modVersion: string | undefined
): string {
  const defaultOutputName = `${modId ?? "mod"}-${modVersion ?? "0"}-${input.targetMapping}.jar`;
  return input.outputJar
    ? normalizePathForHost(input.outputJar, undefined, "outputJar")
    : join(dirname(normalizedInput), defaultOutputName);
}

function copyJarToDestination(sourceJar: string, destinationJar: string): void {
  if (sourceJar === destinationJar) {
    return;
  }
  mkdirSync(dirname(destinationJar), { recursive: true });
  copyFileSync(sourceJar, destinationJar);
}

function buildCacheKey(
  inputJar: string,
  fromNamespace: string,
  targetNamespace: "yarn" | "mojang",
  mcVersion: string
): string {
  const stat = statSync(inputJar, { throwIfNoEntry: false });
  const signature = stat ? `${stat.mtimeMs}:${stat.size}` : "unknown";
  return createHash("sha256")
    .update(`${inputJar}|${signature}|${fromNamespace}|${targetNamespace}|${mcVersion}`)
    .digest("hex");
}

export async function remapModJar(
  input: ModRemapInput,
  config: Config
): Promise<ModRemapResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  // 1. Normalize input JAR path
  const normalizedInput = normalizePathForHost(input.inputJar, undefined, "inputJar");

  if (!normalizedInput.toLowerCase().endsWith(".jar")) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "inputJar must point to a .jar file.",
      details: { inputJar: normalizedInput }
    });
  }

  if (!existsSync(normalizedInput)) {
    throw createError({
      code: ERROR_CODES.JAR_NOT_FOUND,
      message: `Input JAR not found: ${normalizedInput}`,
      details: { inputJar: normalizedInput }
    });
  }
  const resolvedTargetNamespace = normalizeTargetNamespace(input.targetMapping);

  // 2. Analyze mod metadata
  const analysis = await analyzeModJar(normalizedInput);

  if (analysis.loader === "unknown") {
    throw createError({
      code: ERROR_CODES.REMAP_FAILED,
      message: "Could not detect mod loader. Only Fabric and Quilt mods are supported.",
      details: { inputJar: normalizedInput }
    });
  }

  const namespaceDetection = await detectInputNamespaceForLoader(normalizedInput, analysis.loader);
  warnings.push(...namespaceDetection.warnings);
  const fromNamespace = namespaceDetection.fromNamespace;

  // 3. Determine MC version
  const mcVersion = input.mcVersion ?? extractMinecraftVersion(analysis.dependencies);
  if (!mcVersion) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Could not determine Minecraft version from mod metadata. Please provide mcVersion explicitly.",
      details: {
        inputJar: normalizedInput,
        loader: analysis.loader,
        modId: analysis.modId
      }
    });
  }

  const outputJar = resolveOutputJarPath(
    input,
    normalizedInput,
    analysis.modId,
    analysis.modVersion
  );

  // 4. Check cache after mapping context is known
  const cacheKey = buildCacheKey(
    normalizedInput,
    fromNamespace,
    resolvedTargetNamespace,
    mcVersion
  );
  const cacheDir = join(config.cacheDir, "remapped-mods");
  mkdirSync(cacheDir, { recursive: true });
  const cachedOutput = join(cacheDir, `${cacheKey}.jar`);

  if (existsSync(cachedOutput)) {
    const cacheHitOutputJar = input.outputJar
      ? outputJar
      : cachedOutput;
    copyJarToDestination(cachedOutput, cacheHitOutputJar);

    log("info", "remap.cache-hit", { inputJar: normalizedInput, outputJar: cacheHitOutputJar });
    return {
      outputJar: cacheHitOutputJar,
      mcVersion,
      fromMapping: fromNamespace,
      targetMapping: input.targetMapping,
      resolvedTargetNamespace,
      durationMs: Date.now() - startedAt,
      warnings: [...warnings, "Result served from cache."]
    };
  }

  if (fromNamespace === resolvedTargetNamespace) {
    copyJarToDestination(normalizedInput, outputJar);
    copyJarToDestination(normalizedInput, cachedOutput);
    warnings.push(`Input JAR already uses ${fromNamespace} names; output is a copy of the input JAR.`);
    return {
      outputJar,
      mcVersion,
      fromMapping: fromNamespace,
      targetMapping: input.targetMapping,
      resolvedTargetNamespace,
      durationMs: Date.now() - startedAt,
      warnings
    };
  }

  if (fromNamespace === "mojang" && resolvedTargetNamespace === "yarn") {
    throw createError({
      code: ERROR_CODES.REMAP_FAILED,
      message: "Mojang-mapped Fabric/Quilt input jars cannot be remapped to yarn with the available mapping files.",
      details: {
        inputJar: normalizedInput,
        mcVersion,
        fromMapping: fromNamespace,
        targetMapping: input.targetMapping,
        resolvedTargetNamespace,
        nextAction:
          'Use targetMapping="mojang" for Mojang-mapped inputs, or rebuild the mod against intermediary mappings before requesting yarn output.'
      }
    });
  }

  // 5. Resolve tiny-remapper
  const tinyRemapperJar = await resolveTinyRemapperJar(config.cacheDir, config.tinyRemapperJarPath);

  // 6. Resolve mapping file and remap
  let mappingsFile: string;
  let toNamespace: string;
  if (resolvedTargetNamespace === "yarn") {
    mappingsFile = await resolveTinyMappingFile(mcVersion, "yarn", config.cacheDir);
    toNamespace = "named";
  } else {
    const mojangTiny = await resolveMojangTinyFile(mcVersion, config);
    mappingsFile = mojangTiny.path;
    toNamespace = "mojang";
    warnings.push(...mojangTiny.warnings);
  }

  mkdirSync(dirname(outputJar), { recursive: true });

  // 8. Use temporary directory for intermediate work
  const tempDir = join(tmpdir(), `mcp-remap-${cacheKey.slice(0, 12)}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const tempOutput = join(tempDir, "remapped.jar");

    try {
      await remapJar(tinyRemapperJar, {
        inputJar: normalizedInput,
        outputJar: tempOutput,
        mappingsFile,
        fromNamespace,
        toNamespace,
        timeoutMs: config.remapTimeoutMs,
        maxMemoryMb: config.remapMaxMemoryMb
      });
    } catch (caughtError) {
      if (isAppError(caughtError)) {
        throw createError({
          code: caughtError.code,
          message: caughtError.message,
          details: {
            ...(caughtError.details ?? {}),
            fromMapping: fromNamespace,
            targetMapping: input.targetMapping,
            resolvedTargetNamespace
          }
        });
      }
      throw caughtError;
    }

    // Copy to final destination and cache
    copyFileSync(tempOutput, outputJar);

    if (outputJar !== cachedOutput) {
      mkdirSync(dirname(cachedOutput), { recursive: true });
      copyFileSync(tempOutput, cachedOutput);
    }

    const durationMs = Date.now() - startedAt;

    log("info", "remap.pipeline.done", {
      inputJar: normalizedInput,
      outputJar,
      mcVersion,
      fromMapping: fromNamespace,
      targetMapping: input.targetMapping,
      durationMs
    });

    return {
      outputJar,
      mcVersion,
      fromMapping: fromNamespace,
      targetMapping: input.targetMapping,
      resolvedTargetNamespace,
      durationMs,
      warnings
    };
  } finally {
    // Cleanup temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
