import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { decompileBinaryJar } from "./decompiler/vineflower.js";
import { resolveVineflowerJar } from "./vineflower-resolver.js";
import { analyzeModJar, type ModAnalysisResult } from "./mod-analyzer.js";
import { validateAndNormalizeJarPath } from "./path-resolver.js";
import type { Config } from "./types.js";

export type DecompileModJarInput = {
  jarPath: string;
  className?: string;
};

export type DecompileModJarOutput = {
  modId: string;
  modName?: string;
  modVersion?: string;
  loader: string;
  outputDir: string;
  fileCount: number;
  files?: string[];
  source?: {
    className: string;
    content: string;
    totalLines: number;
  };
  warnings: string[];
};

export type GetModClassSourceInput = {
  jarPath: string;
  className: string;
  maxLines?: number;
  maxChars?: number;
  outputFile?: string;
};

export type GetModClassSourceOutput = {
  className: string;
  content: string;
  totalLines: number;
  truncated?: boolean;
  charsTruncated?: boolean;
  outputFilePath?: string;
  modId?: string;
  warnings: string[];
};

const DECOMPILE_TIMEOUT_MS = 300_000;

function modDecompileCacheKey(jarPath: string): string {
  return createHash("sha256").update(jarPath).digest("hex");
}

function classNameToFilePath(className: string): string {
  return className.replaceAll(".", "/") + ".java";
}

function filePathToClassName(filePath: string): string {
  return filePath.replace(/\.java$/, "").replaceAll("/", ".");
}

export class ModDecompileService {
  private readonly config: Config;
  // Cache: jarPath hash → decompiled output dir + file list
  private readonly decompileCache = new Map<
    string,
    { outputDir: string; files: string[]; analysis: ModAnalysisResult }
  >();

  constructor(config: Config) {
    this.config = config;
  }

  async decompileModJar(input: DecompileModJarInput): Promise<DecompileModJarOutput> {
    const jarPath = validateAndNormalizeJarPath(input.jarPath);

    const warnings: string[] = [];
    const { outputDir, files, analysis } = await this.ensureDecompiled(jarPath, warnings);

    let sourceResult: DecompileModJarOutput["source"];
    if (input.className) {
      const targetFile = classNameToFilePath(input.className);
      const matched = files.find(
        (f) => f === targetFile || f.endsWith(`/${targetFile}`) || f === input.className
      );
      if (matched) {
        const content = readFileSync(join(outputDir, matched), "utf8");
        sourceResult = {
          className: filePathToClassName(matched),
          content,
          totalLines: content.split("\n").length
        };
      } else {
        warnings.push(
          `Class "${input.className}" not found in decompiled output. Use the files list to find available classes.`
        );
      }
    }

    return {
      modId: analysis.modId ?? "unknown",
      modName: analysis.modName,
      modVersion: analysis.modVersion,
      loader: analysis.loader,
      outputDir,
      fileCount: files.length,
      files: input.className ? undefined : files.map(filePathToClassName),
      source: sourceResult,
      warnings
    };
  }

  async getModClassSource(input: GetModClassSourceInput): Promise<GetModClassSourceOutput> {
    const jarPath = validateAndNormalizeJarPath(input.jarPath);
    const className = input.className.trim();
    if (!className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "className must be non-empty."
      });
    }

    const warnings: string[] = [];
    const { outputDir, files, analysis } = await this.ensureDecompiled(jarPath, warnings);

    const targetFile = classNameToFilePath(className);
    const matched = files.find(
      (f) => f === targetFile || f.endsWith(`/${targetFile}`)
    );

    if (!matched) {
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: `Class "${className}" not found in decompiled mod JAR.`,
        details: { className, jarPath, availableCount: files.length }
      });
    }

    const fullContent = readFileSync(join(outputDir, matched), "utf8");
    const totalLines = fullContent.split("\n").length;
    let content = fullContent;
    let truncated: boolean | undefined;
    let charsTruncated: boolean | undefined;
    let outputFilePath: string | undefined;

    // Apply maxLines truncation
    if (input.maxLines != null && input.maxLines > 0) {
      const lines = content.split("\n");
      if (lines.length > input.maxLines) {
        content = lines.slice(0, input.maxLines).join("\n");
        truncated = true;
      }
    }

    // Apply maxChars truncation
    if (input.maxChars != null && input.maxChars > 0 && content.length > input.maxChars) {
      content = content.slice(0, input.maxChars);
      charsTruncated = true;
      truncated = true;
    }

    // Write to outputFile if specified (after maxLines/maxChars truncation, if any)
    if (input.outputFile) {
      const outPath = isAbsolute(input.outputFile)
        ? input.outputFile
        : resolvePath(input.outputFile);
      writeFileSync(outPath, content, "utf8");
      outputFilePath = outPath;
      content = `[Written to ${outPath}]`;
    }

    return {
      className: filePathToClassName(matched),
      content,
      totalLines,
      truncated,
      charsTruncated,
      outputFilePath,
      modId: analysis.modId,
      warnings
    };
  }

  private async ensureDecompiled(
    jarPath: string,
    warnings: string[]
  ): Promise<{ outputDir: string; files: string[]; analysis: ModAnalysisResult }> {
    const cacheKey = modDecompileCacheKey(jarPath);
    const cached = this.decompileCache.get(cacheKey);
    if (cached) return cached;

    log("info", "mod-decompile.start", { jarPath });
    const startedAt = Date.now();

    // Analyze mod metadata
    let analysis: ModAnalysisResult;
    try {
      analysis = await analyzeModJar(jarPath, { includeClasses: false });
    } catch {
      analysis = {
        loader: "unknown",
        jarKind: "binary",
        classCount: 0
      };
      warnings.push("Could not extract mod metadata from JAR.");
    }

    // Resolve Vineflower
    const vineflowerPath = await resolveVineflowerJar(
      this.config.cacheDir,
      this.config.vineflowerJarPath
    );

    // Decompile
    const decompileResult = await decompileBinaryJar(jarPath, this.config.cacheDir, {
      vineflowerJarPath: vineflowerPath,
      timeoutMs: DECOMPILE_TIMEOUT_MS,
      signature: cacheKey
    });

    const files = decompileResult.javaFiles.map((entry) => entry.filePath);
    const result = {
      outputDir: decompileResult.outputDir,
      files,
      analysis
    };

    this.decompileCache.set(cacheKey, result);

    // Trim cache
    if (this.decompileCache.size > 8) {
      const oldest = this.decompileCache.keys().next().value;
      if (oldest !== undefined) this.decompileCache.delete(oldest);
    }

    log("info", "mod-decompile.done", {
      jarPath,
      fileCount: files.length,
      durationMs: Date.now() - startedAt
    });

    return result;
  }
}
