import { access, constants } from "node:fs/promises";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { assertJavaAvailable, runJavaProcess } from "../java-process.js";
import { log } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface DecompileResult {
  outputDir: string;
  javaFiles: Array<{
    filePath: string;
    content: string;
  }>;
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

function collectJavaFilesSync(baseDir: string, currentDir = ""): string[] {
  const absoluteBase = currentDir ? join(baseDir, currentDir) : baseDir;
  const entries = readdirSync(absoluteBase, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    const next = currentDir ? join(currentDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      result.push(...collectJavaFilesSync(baseDir, next));
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
      default?: { sync: (pattern: string, options: { cwd: string; onlyFiles: boolean }) => string[] };
    };
    const sync = fastGlobModule.default?.sync;
    if (typeof sync === "function") {
      return sync("**/*.java", { cwd: baseDir, onlyFiles: true });
    }
  } catch {
    // optional dependency: fallback to recursive traversal
  }

  return collectJavaFilesSync(baseDir).map((candidate) => candidate.split(sep).join("/"));
}

function readFileTreeText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:fs/promises")
      .then((fs) => fs.readFile(filePath, "utf8"))
      .then(resolve)
      .catch(reject);
  });
}

function decompileOutputDir(cacheDir: string, binaryJarPath: string, signature: string): string {
  const digest = createHash("sha256").update(binaryJarPath).update(signature).digest("hex");
  return join(cacheDir, "decompiled", digest);
}

async function runVineflower(
  vineflowerJarPath: string,
  binaryJarPath: string,
  outputDir: string,
  timeoutMs: number
): Promise<void> {
  const result = await runJavaProcess({
    jarPath: vineflowerJarPath,
    args: [binaryJarPath, outputDir, "-din=1", "-rbr=1", "-dgs=1"],
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
    mkdirSync(outputDir, { recursive: true });
    await assertVineflowerAvailable(options.vineflowerJarPath);
    await assertJavaAvailable();

    if (statSync(outputDir, { throwIfNoEntry: false })) {
      const existingJavaFiles = await collectJavaFiles(outputDir);
      if (existingJavaFiles.length > 0) {
        const results = await Promise.all(
          existingJavaFiles.map(async (candidate) => {
            const abs = join(outputDir, candidate);
            return {
              filePath: normalizeOutputPath(outputDir, abs),
              content: await readFileTreeText(abs)
            };
          })
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

    await runVineflower(options.vineflowerJarPath, normalizedBinaryJarPath, outputDir, timeoutMs);
    const javaFileNames = await collectJavaFiles(outputDir);
    if (javaFileNames.length === 0) {
      throw createError({
        code: ERROR_CODES.DECOMPILER_FAILED,
        message: "No Java files were produced by decompilation.",
        details: {
          binaryJarPath: normalizedBinaryJarPath,
          outputDir,
          producedJavaCount: 0
        }
      });
    }

    const javaFiles = await Promise.all(
      javaFileNames.map(async (candidate) => {
        const abs = join(outputDir, candidate);
        return {
          filePath: normalizeOutputPath(outputDir, abs),
          content: await readFileTreeText(abs)
        };
      })
    );

    emitDecompileLog("decompile.done", {
      durationMs: Date.now() - startedAt,
      artifactIdCandidate: options.artifactIdCandidate,
      javaFileCount: javaFiles.length
    });

    return {
      outputDir,
      javaFiles
    };
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
