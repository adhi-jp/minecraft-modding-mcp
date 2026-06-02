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
import { detectFabricLikeInputNamespace, listJarEntries, readJarEntryAsBuffer } from "./source-jar-reader.js";
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

/**
 * Injectable external dependencies, used by tests to drive the remap pipeline
 * without spawning Java or downloading mapping jars. Production callers omit it.
 */
export interface RemapModJarDeps {
  remapJar?: typeof remapJar;
  resolveTinyMappingFile?: typeof resolveTinyMappingFile;
  resolveMojangTinyFile?: typeof resolveMojangTinyFile;
  resolveTinyRemapperJar?: typeof resolveTinyRemapperJar;
}

// Bumped whenever the remap pipeline changes in a way that makes previously
// cached output jars wrong. The v1 pipeline mis-mapped intermediary jars to
// mojang using an obfuscated<->mojang tiny (no intermediary namespace), so any
// cached mojang output is invalid and must not be reused.
const REMAP_PIPELINE_VERSION = "v2";

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
    .update(`${REMAP_PIPELINE_VERSION}|${inputJar}|${signature}|${fromNamespace}|${targetNamespace}|${mcVersion}`)
    .digest("hex");
}

export async function remapModJar(
  input: ModRemapInput,
  config: Config,
  deps: RemapModJarDeps = {}
): Promise<ModRemapResult> {
  const remapJarFn = deps.remapJar ?? remapJar;
  const resolveTinyMappingFileFn = deps.resolveTinyMappingFile ?? resolveTinyMappingFile;
  const resolveMojangTinyFileFn = deps.resolveMojangTinyFile ?? resolveMojangTinyFile;
  const resolveTinyRemapperJarFn = deps.resolveTinyRemapperJar ?? resolveTinyRemapperJar;
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
  const tinyRemapperJar = await resolveTinyRemapperJarFn(config.cacheDir, config.tinyRemapperJarPath);

  // 6. Build the remap plan. Each pass uses a mapping file whose source column
  // actually contains the names present in that pass's input jar.
  type RemapPass = { mappingsFile: string; fromNamespace: string; toNamespace: string };
  const passes: RemapPass[] = [];
  if (resolvedTargetNamespace === "yarn") {
    // The Fabric yarn v2 tiny declares both intermediary and named, so a single
    // intermediary -> named pass is sufficient.
    const yarnTiny = await resolveTinyMappingFileFn(mcVersion, "yarn", config.cacheDir);
    passes.push({ mappingsFile: yarnTiny, fromNamespace, toNamespace: "named" });
  } else {
    // Mojang target. The merged mojang tiny only bridges obfuscated <-> mojang,
    // but a Fabric/Quilt jar is intermediary-named, so a direct intermediary ->
    // mojang remap finds no matching keys and silently no-ops. Remap in two passes:
    //   pass 1: intermediary -> official (= obfuscated) via the Fabric intermediary v2 tiny
    //   pass 2: obfuscated    -> mojang                via the merged mojang tiny
    const mojangTiny = await resolveMojangTinyFileFn(mcVersion, config);
    warnings.push(...mojangTiny.warnings);
    if (fromNamespace === "intermediary") {
      const intermediaryTiny = await resolveTinyMappingFileFn(mcVersion, "intermediary", config.cacheDir);
      passes.push({ mappingsFile: intermediaryTiny, fromNamespace: "intermediary", toNamespace: "official" });
      passes.push({ mappingsFile: mojangTiny.path, fromNamespace: "obfuscated", toNamespace: "mojang" });
    } else {
      // Defensive: an already-obfuscated input maps directly. (mojang -> mojang is
      // handled earlier by the copy short-circuit, so this is not normally reached.)
      passes.push({ mappingsFile: mojangTiny.path, fromNamespace: "obfuscated", toNamespace: "mojang" });
    }
  }

  mkdirSync(dirname(outputJar), { recursive: true });

  // 7. Use a temporary directory for intermediate work
  const tempDir = join(tmpdir(), `mcp-remap-${cacheKey.slice(0, 12)}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    let passInput = normalizedInput;
    let tempOutput = "";
    for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
      const pass = passes[passIndex]!;
      tempOutput = join(tempDir, `pass-${passIndex}.jar`);
      try {
        await remapJarFn(tinyRemapperJar, {
          inputJar: passInput,
          outputJar: tempOutput,
          mappingsFile: pass.mappingsFile,
          fromNamespace: pass.fromNamespace,
          toNamespace: pass.toNamespace,
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
              resolvedTargetNamespace,
              pass: `${pass.fromNamespace}->${pass.toNamespace}`
            }
          });
        }
        throw caughtError;
      }
      passInput = tempOutput;
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
