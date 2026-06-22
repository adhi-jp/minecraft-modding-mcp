import { access, constants, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

import { mapWithConcurrencyLimit } from "../concurrency.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { assertJavaAvailable, runJavaProcess } from "../java-process.js";
import { log } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DECOMPILED_JAVA_READ_CONCURRENCY = 8;
const DECOMPILE_COMPLETE_MARKER = ".decompile-complete";

const VINEFLOWER_FLAG_PROFILES: ReadonlyArray<{ label: string; flags: string[] }> = [
  { label: "default", flags: ["-din=1", "-rbr=1", "-dgs=1"] },
  { label: "relaxed", flags: ["-din=1", "-rbr=0", "-dgs=0"] },
  { label: "safe",    flags: ["-din=0", "-rbr=0", "-dgs=0"] },
];

export interface DecompileResult {
  outputDir: string;
  javaFiles: Array<{
    filePath: string;
    content: string;
  }>;
  decompileProfile?: string;
}

interface DecompileBinaryOptions {
  vineflowerJarPath?: string;
  timeoutMs?: number;
  signature?: string;
  artifactIdCandidate?: string;
}

function emitDecompileLog(event: string, details: Record<string, unknown>): void {
  log(event === "decompile.error" ? "error" : "info", event, details);
}

function extractStderrTail(error: unknown): string | undefined {
  if (!isAppError(error)) {
    return undefined;
  }

  const tail = error.details?.stderrTail;
  return typeof tail === "string" ? tail : undefined;
}

function normalizeBinaryJarPath(binaryJarPath: string): string {
  const normalized = binaryJarPath.trim();
  if (!normalized.toLowerCase().endsWith(".jar")) {
    throw createError({
      code: ERROR_CODES.DECOMPILER_UNAVAILABLE,
      message: "binaryJarPath must point to a .jar file.",
      details: { binaryJarPath }
    });
  }
  return normalized;
}

function normalizeOutputPath(root: string, childPath: string): string {
  return relative(root, childPath).split(sep).join("/");
}

async function assertVineflowerAvailable(vineflowerJarPath: string): Promise<void> {
  try {
    await access(vineflowerJarPath, constants.F_OK | constants.R_OK);
  } catch {
    throw createError({
      code: ERROR_CODES.DECOMPILER_UNAVAILABLE,
      message: "Vineflower jar is not available.",
      details: { vineflowerJarPath }
    });
  }
}

async function collectJavaFilesRecursive(baseDir: string, currentDir = ""): Promise<string[]> {
  const absoluteBase = currentDir ? join(baseDir, currentDir) : baseDir;
  const entries = await readdir(absoluteBase, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    const next = currentDir ? join(currentDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      result.push(...await collectJavaFilesRecursive(baseDir, next));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".java")) {
      result.push(next);
    }
  }

  return result;
}

async function collectJavaFiles(baseDir: string): Promise<string[]> {
  try {
    const fastGlobModule = (await import("fast-glob")) as {
      default?: { glob: (pattern: string, options: { cwd: string; onlyFiles: boolean }) => Promise<string[]> };
    };
    const glob = fastGlobModule.default?.glob;
    if (typeof glob === "function") {
      return (await glob("**/*.java", { cwd: baseDir, onlyFiles: true }))
        .sort((left, right) => left.localeCompare(right));
    }
  } catch {
    // optional dependency: fallback to recursive traversal
  }

  return (await collectJavaFilesRecursive(baseDir))
    .map((candidate) => candidate.split(sep).join("/"))
    .sort((left, right) => left.localeCompare(right));
}

function readFileTreeText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function decompileOutputDir(cacheDir: string, binaryJarPath: string, signature: string): string {
  const digest = createHash("sha256").update(binaryJarPath).update(signature).digest("hex");
  return join(cacheDir, "decompiled", digest);
}

function clearOutputDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

async function runVineflower(
  vineflowerJarPath: string,
  binaryJarPath: string,
  outputDir: string,
  timeoutMs: number,
  flags: string[] = VINEFLOWER_FLAG_PROFILES[0].flags
): Promise<void> {
  const result = await runJavaProcess({
    jarPath: vineflowerJarPath,
    args: [...flags, binaryJarPath, outputDir],
    timeoutMs,
    normalizePathArgs: true
  });

  if (result.exitCode !== 0) {
    throw createError({
      code: ERROR_CODES.DECOMPILER_FAILED,
      message: `Vineflower exited with code ${result.exitCode}.`,
      details: {
        binaryJarPath,
        outputDir,
        exitCode: result.exitCode,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail
      }
    });
  }
}

export async function decompileBinaryJar(
  binaryJarPath: string,
  cacheDir: string,
  options?: DecompileBinaryOptions
): Promise<DecompileResult> {
  const normalizedBinaryJarPath = normalizeBinaryJarPath(binaryJarPath);

  if (!options?.vineflowerJarPath) {
    throw createError({
      code: ERROR_CODES.DECOMPILER_UNAVAILABLE,
      message: "Vineflower JAR path was not resolved. Set MCP_VINEFLOWER_JAR_PATH or ensure auto-download can reach GitHub."
    });
  }

  const startedAt = Date.now();
  emitDecompileLog("decompile.start", {
    binaryJarPath: normalizedBinaryJarPath,
    artifactIdCandidate: options.artifactIdCandidate
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signature = options.signature ?? basename(normalizedBinaryJarPath);
  const outputDir = decompileOutputDir(cacheDir, normalizedBinaryJarPath, signature).replace(/[/\\]$/, "");

  try {
    await mkdir(outputDir, { recursive: true });

    const outputDirStats = await stat(outputDir).catch(() => undefined);
    const markerPresent = outputDirStats
      ? await access(join(outputDir, DECOMPILE_COMPLETE_MARKER), constants.F_OK).then(() => true, () => false)
      : false;
    if (outputDirStats && markerPresent) {
      const existingJavaFiles = await collectJavaFiles(outputDir);
      if (existingJavaFiles.length > 0) {
        const results = await mapWithConcurrencyLimit(
          existingJavaFiles,
          DECOMPILED_JAVA_READ_CONCURRENCY,
          async (candidate) => {
            const abs = join(outputDir, candidate);
            return {
              filePath: normalizeOutputPath(outputDir, abs),
              content: await readFileTreeText(abs)
            };
          }
        );
        emitDecompileLog("decompile.done", {
          durationMs: Date.now() - startedAt,
          artifactIdCandidate: options.artifactIdCandidate,
          javaFileCount: results.length
        });

        return {
          outputDir,
          javaFiles: results
        };
      }
    }

    clearOutputDir(outputDir);

    await assertVineflowerAvailable(options.vineflowerJarPath);
    await assertJavaAvailable();

    const profilesAttempted: string[] = [];
    let lastDecompileError: unknown;

    for (const profile of VINEFLOWER_FLAG_PROFILES) {
      profilesAttempted.push(profile.label);
      try {
        if (profilesAttempted.length > 1) {
          clearOutputDir(outputDir);
          emitDecompileLog("decompile.retry", {
            binaryJarPath: normalizedBinaryJarPath,
            profile: profile.label,
            attempt: profilesAttempted.length
          });
        }

        await runVineflower(options.vineflowerJarPath, normalizedBinaryJarPath, outputDir, timeoutMs, profile.flags);
        const javaFileNames = await collectJavaFiles(outputDir);
        if (javaFileNames.length === 0) {
          throw createError({
            code: ERROR_CODES.DECOMPILER_FAILED,
            message: "No Java files were produced by decompilation.",
            details: {
              binaryJarPath: normalizedBinaryJarPath,
              outputDir,
              producedJavaCount: 0,
              profile: profile.label
            }
          });
        }

        const javaFiles = await mapWithConcurrencyLimit(
          javaFileNames,
          DECOMPILED_JAVA_READ_CONCURRENCY,
          async (candidate) => {
            const abs = join(outputDir, candidate);
            return {
              filePath: normalizeOutputPath(outputDir, abs),
              content: await readFileTreeText(abs)
            };
          }
        );

        await writeFile(join(outputDir, DECOMPILE_COMPLETE_MARKER), profile.label, "utf8");

        emitDecompileLog("decompile.done", {
          durationMs: Date.now() - startedAt,
          artifactIdCandidate: options.artifactIdCandidate,
          javaFileCount: javaFiles.length,
          profile: profile.label
        });

        return {
          outputDir,
          javaFiles,
          decompileProfile: profile.label
        };
      } catch (retryError) {
        if (isAppError(retryError) && retryError.code !== ERROR_CODES.DECOMPILER_FAILED) {
          throw retryError;
        }
        lastDecompileError = retryError;
      }
    }

    throw isAppError(lastDecompileError)
      ? createError({
          code: ERROR_CODES.DECOMPILER_FAILED,
          message: `Decompilation failed after trying all flag profiles.`,
          details: {
            binaryJarPath: normalizedBinaryJarPath,
            outputDir,
            profilesAttempted,
            stderrTail: extractStderrTail(lastDecompileError)
          }
        })
      : lastDecompileError;
  } catch (error) {
    emitDecompileLog("decompile.error", {
      durationMs: Date.now() - startedAt,
      binaryJarPath: normalizedBinaryJarPath,
      artifactIdCandidate: options.artifactIdCandidate,
      code: isAppError(error) ? error.code : ERROR_CODES.DECOMPILER_FAILED,
      stderrTail: extractStderrTail(error)
    });
    throw error;
  }
}
