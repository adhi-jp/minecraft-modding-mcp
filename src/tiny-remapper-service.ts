import { existsSync } from "node:fs";

import { createError, ERROR_CODES } from "./errors.js";
import { javaRunner } from "./java-process.js";
import { log } from "./logger.js";

export interface RemapOptions {
  inputJar: string;
  outputJar: string;
  mappingsFile: string;
  fromNamespace: string;
  toNamespace: string;
  timeoutMs?: number;
  maxMemoryMb?: number;
}

export interface RemapResult {
  outputJar: string;
  durationMs: number;
}

export async function remapJar(
  tinyRemapperJarPath: string,
  options: RemapOptions
): Promise<RemapResult> {
  const {
    inputJar,
    outputJar,
    mappingsFile,
    fromNamespace,
    toNamespace,
    timeoutMs = 600_000,
    maxMemoryMb = 4096
  } = options;

  await javaRunner.assertAvailable();

  log("info", "remap.start", {
    inputJar,
    outputJar,
    fromNamespace,
    toNamespace
  });

  const startedAt = Date.now();

  const args = [inputJar, outputJar, mappingsFile, fromNamespace, toNamespace];

  try {
    const result = await javaRunner.run({
      jarPath: tinyRemapperJarPath,
      args,
      timeoutMs,
      maxMemoryMb,
      normalizePathArgs: true
    });

    const durationMs = Date.now() - startedAt;

    if (result.exitCode !== 0) {
      throw createError({
        code: ERROR_CODES.REMAP_FAILED,
        message: `tiny-remapper exited with code ${result.exitCode}.`,
        details: {
          inputJar,
          outputJar,
          exitCode: result.exitCode,
          stderrTail: result.stderrTail
        }
      });
    }

    if (!existsSync(outputJar)) {
      throw createError({
        code: ERROR_CODES.REMAP_FAILED,
        message: "tiny-remapper did not produce an output JAR.",
        details: {
          inputJar,
          outputJar,
          stderrTail: result.stderrTail
        }
      });
    }

    log("info", "remap.done", {
      inputJar,
      outputJar,
      durationMs
    });

    return { outputJar, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    log("error", "remap.error", {
      inputJar,
      outputJar,
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
