import { realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactSignature } from "./types.js";
import { normalizePathForHost } from "./path-converter.js";
import { createError, ERROR_CODES, isAppError } from "./errors.js";

export interface ResolvedJarInfo {
  originalPath: string;
  resolvedPath: string;
}

const INVALID_ENTRY = /(^|\/|\\)\.\.(\/|\\|$)/;

export function normalizeJarPath(jarPath: string): string {
  const normalizedInput = normalizePathForHost(jarPath, undefined, "jarPath");
  const absolute = resolve(normalizedInput);
  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(absolute, { throwIfNoEntry: false });
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    throw createError({
      code: ERROR_CODES.JAR_NOT_FOUND,
      message: `Could not access jar "${normalizedInput}".`,
      details: {
        jarPath: normalizedInput,
        reason: cause instanceof Error ? cause.message : String(cause)
      }
    });
  }

  if (!stats) {
    throw createError({
      code: ERROR_CODES.JAR_NOT_FOUND,
      message: `Jar not found: "${normalizedInput}".`,
      details: { jarPath: normalizedInput }
    });
  }

  if (!stats.isFile()) {
    throw createError({
      code: ERROR_CODES.JAR_NOT_FOUND,
      message: `Expected a file path for jar, got "${normalizedInput}".`,
      details: { jarPath: normalizedInput }
    });
  }

  if (extname(absolute).toLowerCase() !== ".jar") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Expected a .jar file, got "${normalizedInput}".`,
      details: { jarPath: normalizedInput }
    });
  }

  try {
    return realpathSync(absolute);
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    throw createError({
      code: ERROR_CODES.JAR_NOT_FOUND,
      message: `Could not resolve jar "${normalizedInput}".`,
      details: {
        jarPath: normalizedInput,
        reason: cause instanceof Error ? cause.message : String(cause)
      }
    });
  }
}

export function resolveJarPathWithSymlinkCheck(jarPath: string): ResolvedJarInfo {
  const resolvedPath = normalizeJarPath(jarPath);
  return {
    originalPath: jarPath,
    resolvedPath
  };
}

export function buildJarSignature(stats: { mtimeMs: number; size: number }): string {
  return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
}

export function artifactSignatureFromFile(jarPath: string): ArtifactSignature {
  const resolvedPath = resolveJarPathWithSymlinkCheck(jarPath).resolvedPath;
  const stats = statSync(resolvedPath);
  return {
    sourcePath: resolvedPath,
    sourceArtifactId: createHash("sha256").update(`jar|${resolvedPath}|${buildJarSignature(stats)}`).digest("hex"),
    signature: buildJarSignature(stats),
    signatureParts: {
      mtimeMs: stats.mtimeMs,
      size: stats.size
    }
  };
}

export function isSecureJarEntryPath(entryPath: string): boolean {
  return !INVALID_ENTRY.test(entryPath.replaceAll("\\", "/"));
}

/**
 * Validate and normalize a user-supplied jar path input.
 * Trims whitespace, validates non-empty, resolves symlinks, and wraps
 * any filesystem error as ERR_INVALID_INPUT.
 */
export function validateAndNormalizeJarPath(jarPathInput: string): string {
  const jarPath = jarPathInput.trim();
  if (!jarPath) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "jarPath must be non-empty."
    });
  }

  try {
    return normalizeJarPath(jarPath);
  } catch (cause) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: cause instanceof Error ? cause.message : `Invalid jar path: "${jarPath}".`,
      details: { jarPath }
    });
  }
}
