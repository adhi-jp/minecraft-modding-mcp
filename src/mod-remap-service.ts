import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { resolveTinyMappingFile } from "./mapping-service.js";
import { resolveMojangTinyFile } from "./mojang-tiny-mapping-service.js";
import { analyzeModJar, type ModLoader } from "./mod-analyzer.js";
import { normalizePathForHost } from "./path-converter.js";
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

function sourceNamespaceForLoader(loader: ModLoader): string {
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

  const fromNamespace = sourceNamespaceForLoader(analysis.loader);

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
    const outputJar = input.outputJar
      ? normalizePathForHost(input.outputJar, undefined, "outputJar")
      : cachedOutput;

    if (outputJar !== cachedOutput) {
      const { copyFileSync } = await import("node:fs");
      mkdirSync(dirname(outputJar), { recursive: true });
      copyFileSync(cachedOutput, outputJar);
    }

    log("info", "remap.cache-hit", { inputJar: normalizedInput, outputJar });
    return {
      outputJar,
      mcVersion,
      fromMapping: fromNamespace,
      targetMapping: input.targetMapping,
      resolvedTargetNamespace,
      durationMs: Date.now() - startedAt,
      warnings: ["Result served from cache."]
    };
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

  // 7. Determine output path
  const modId = analysis.modId ?? "mod";
  const modVersion = analysis.modVersion ?? "0";
  const defaultOutputName = `${modId}-${modVersion}-${input.targetMapping}.jar`;
  const outputJar = input.outputJar
    ? normalizePathForHost(input.outputJar, undefined, "outputJar")
    : join(dirname(normalizedInput), defaultOutputName);

  mkdirSync(dirname(outputJar), { recursive: true });

  // 8. Use temporary directory for intermediate work
  const tempDir = join(tmpdir(), `mcp-remap-${cacheKey.slice(0, 12)}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const tempOutput = join(tempDir, "remapped.jar");

    await remapJar(tinyRemapperJar, {
      inputJar: normalizedInput,
      outputJar: tempOutput,
      mappingsFile,
      fromNamespace,
      toNamespace,
      timeoutMs: config.remapTimeoutMs,
      maxMemoryMb: config.remapMaxMemoryMb
    });

    // Copy to final destination and cache
    const { copyFileSync } = await import("node:fs");
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
