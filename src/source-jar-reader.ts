import type { Readable } from "node:stream";

import * as yauzl from "yauzl";
import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { isSecureJarEntryPath } from "./path-resolver.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// Test-only instrumentation: counts real jar opens at the single openZipFile
// chokepoint so perf tests can assert N-opens-per-call collapses to 1.
let zipOpenCount = 0;
export function __getZipOpenCount(): number {
  return zipOpenCount;
}
export function __resetZipOpenCount(): void {
  zipOpenCount = 0;
}

interface ZipEntry {
  fileName: string;
  uncompressedSize: number;
}

export interface ZipFile {
  readEntry(): void;
  close(): void;
  once(event: "entry", listener: (entry: ZipEntry) => void): this;
  once(event: "end", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "entry", listener: (entry: ZipEntry) => void): this;
  removeListener(event: "end", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  openReadStream(
    entry: ZipEntry,
    callback: (error: Error | null, stream: Readable | null) => void
  ): void;
}

export interface JavaEntryText {
  filePath: string;
  content: string;
}

export interface JarEntryText {
  filePath: string;
  content: string;
}

export interface CollectMatchedJarEntriesOptions {
  maxBytes?: number;
  maxEntries?: number;
  continueOnError?: boolean;
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

export function hasJavaSourceExtension(entryPath: string): boolean {
  const suffix = ".java";
  if (entryPath.length < suffix.length) {
    return false;
  }

  for (let index = 0; index < suffix.length; index += 1) {
    const charCode = entryPath.charCodeAt(entryPath.length - suffix.length + index);
    const normalizedCharCode = charCode >= 65 && charCode <= 90 ? charCode + 32 : charCode;
    if (normalizedCharCode !== suffix.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

export function openZipFile(jarPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      jarPath,
      {
        lazyEntries: true,
        autoClose: false
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(new Error(`Failed to read jar "${jarPath}": ${toErrorMessage(error)}`));
          return;
        }
        zipOpenCount += 1;
        resolve(zipFile as unknown as ZipFile);
      }
    );
  });
}

async function withZipFile<T>(jarPath: string, action: (zipFile: ZipFile) => Promise<T>): Promise<T> {
  const zipFile = await openZipFile(jarPath);
  try {
    return await action(zipFile);
  } finally {
    zipFile.close();
  }
}

function readNextEntry(zipFile: ZipFile): Promise<ZipEntry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: ZipEntry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
    };

    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

export class EntryTooLargeError extends Error {
  constructor(entryPath: string, jarPath: string, maxBytes: number) {
    super(`Entry "${entryPath}" in "${jarPath}" exceeds size limit of ${maxBytes} bytes`);
    this.name = "EntryTooLargeError";
  }
}

function readEntryStream(
  zipFile: ZipFile, entry: ZipEntry, jarPath: string, maxBytes?: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new Error(
            `Failed to read entry "${entry.fileName}" from "${jarPath}": ${toErrorMessage(error)}`
          )
        );
        return;
      }

      let settled = false;
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (maxBytes !== undefined && totalBytes > maxBytes) {
          settled = true;
          stream.destroy();
          reject(new EntryTooLargeError(entry.fileName, jarPath, maxBytes));
          return;
        }
        chunks.push(buf);
      });
      stream.once("error", (streamError: Error) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to read entry "${entry.fileName}" from "${jarPath}": ${toErrorMessage(streamError)}`
          )
        );
      });
      stream.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

function decodeUtf8OrThrow(contentBuffer: Buffer, jarPath: string, entryPath: string): string {
  try {
    return UTF8_DECODER.decode(contentBuffer);
  } catch {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Entry "${entryPath.replaceAll("\\", "/")}" in "${jarPath}" is not valid UTF-8. Only UTF-8 source files are supported.`,
      details: { jarPath, entryPath: entryPath.replaceAll("\\", "/") }
    });
  }
}

export async function listJarEntries(jarPath: string): Promise<string[]> {
  return withZipFile(jarPath, async (zipFile) => {
    const entries: string[] = [];
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        break;
      }
      entries.push(entry.fileName);
    }
    return entries;
  });
}

export async function listJavaEntries(jarPath: string): Promise<string[]> {
  const entries = await listJarEntries(jarPath);
  return entries.filter((entry) => hasJavaSourceExtension(entry) && isSecureJarEntryPath(entry));
}

export async function hasAnyJarEntry(
  jarPath: string,
  predicate: (entryPath: string) => boolean
): Promise<boolean> {
  return withZipFile(jarPath, async (zipFile) => {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        return false;
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (predicate(entry.fileName)) {
        return true;
      }
    }
  });
}

export async function readJarEntryAsUtf8(jarPath: string, entryPath: string): Promise<string> {
  const contentBuffer = await readJarEntryAsBuffer(jarPath, entryPath);
  return decodeUtf8OrThrow(contentBuffer, jarPath, entryPath);
}

export async function readJarEntryAsBuffer(jarPath: string, entryPath: string): Promise<Buffer> {
  const normalizedTargetPath = entryPath.replaceAll("\\", "/");
  if (!isSecureJarEntryPath(normalizedTargetPath)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Entry path "${normalizedTargetPath}" is not allowed.`,
      details: { jarPath, entryPath: normalizedTargetPath }
    });
  }

  return withZipFile(jarPath, async (zipFile) => {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        throw createError({
          code: ERROR_CODES.SOURCE_NOT_FOUND,
          message: `Entry "${normalizedTargetPath}" was not found in "${jarPath}".`,
          details: { jarPath, entryPath: normalizedTargetPath }
        });
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (entry.fileName !== normalizedTargetPath) {
        continue;
      }
      return readEntryStream(zipFile, entry, jarPath);
    }
  });
}

export interface CappedJarEntry {
  /** At most the requested byte budget of the entry (empty when maxBytes<=0). */
  buffer: Buffer;
  /** Full uncompressed size from the zip metadata, independent of the cap. */
  entrySize: number;
}

/**
 * Reads at most maxBytes of one entry, reporting the full uncompressed size
 * from the zip metadata. Unlike readJarEntryAsBuffer, an oversized entry is
 * never fully materialized: the stream is destroyed once the budget is
 * exceeded and the collected prefix is returned. maxBytes<=0 skips the read
 * entirely (metadata-only probe).
 */
export async function readJarEntryCapped(
  jarPath: string,
  entryPath: string,
  maxBytes: number
): Promise<CappedJarEntry> {
  const normalizedTargetPath = entryPath.replaceAll("\\", "/");
  if (!isSecureJarEntryPath(normalizedTargetPath)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Entry path "${normalizedTargetPath}" is not allowed.`,
      details: { jarPath, entryPath: normalizedTargetPath }
    });
  }

  return withZipFile(jarPath, async (zipFile) => {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        throw createError({
          code: ERROR_CODES.SOURCE_NOT_FOUND,
          message: `Entry "${normalizedTargetPath}" was not found in "${jarPath}".`,
          details: { jarPath, entryPath: normalizedTargetPath }
        });
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (entry.fileName !== normalizedTargetPath) {
        continue;
      }
      const entrySize = entry.uncompressedSize;
      if (maxBytes <= 0) {
        return { buffer: Buffer.alloc(0), entrySize };
      }
      const buffer = await readEntryStreamPrefix(zipFile, entry, jarPath, maxBytes);
      return { buffer: buffer.length > maxBytes ? buffer.slice(0, maxBytes) : buffer, entrySize };
    }
  });
}

/** Like readEntryStream, but resolves with the collected prefix instead of rejecting when the budget is exceeded. */
function readEntryStreamPrefix(
  zipFile: ZipFile,
  entry: ZipEntry,
  jarPath: string,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new Error(
            `Failed to read entry "${entry.fileName}" from "${jarPath}": ${toErrorMessage(error)}`
          )
        );
        return;
      }
      let settled = false;
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        chunks.push(buf);
        if (totalBytes >= maxBytes) {
          settled = true;
          stream.destroy();
          resolve(Buffer.concat(chunks));
        }
      });
      stream.once("error", (streamError: Error) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to read entry "${entry.fileName}" from "${jarPath}": ${toErrorMessage(streamError)}`
          )
        );
      });
      stream.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

export function decodeJarEntryUtf8OrThrow(contentBuffer: Buffer, jarPath: string, entryPath: string): string {
  return decodeUtf8OrThrow(contentBuffer, jarPath, entryPath);
}

export interface JarEntryReader {
  getEntryBuffer(entryPath: string): Promise<Buffer>;
  close(): void;
}

/**
 * Opens a jar ONCE, drains its central directory into a name->entry index, and
 * serves repeated entry reads via O(1) lookup + openReadStream. Use this when a
 * single logical operation reads many entries from the same jar (e.g. walking a
 * class hierarchy) instead of calling {@link readJarEntryAsBuffer} per entry,
 * which re-opens and re-scans the jar each time. Callers MUST close() the reader
 * (in a finally) to release the file descriptor. getEntryBuffer throws the same
 * INVALID_INPUT (unsafe path) / SOURCE_NOT_FOUND (missing entry) errors as
 * readJarEntryAsBuffer; duplicate entry names resolve to the first occurrence.
 */
export async function createJarEntryReader(jarPath: string): Promise<JarEntryReader> {
  const zipFile = await openZipFile(jarPath);
  let closed = false;
  const index = new Map<string, ZipEntry>();
  try {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        break;
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (!index.has(entry.fileName)) {
        index.set(entry.fileName, entry);
      }
    }
  } catch (error) {
    zipFile.close();
    throw error;
  }

  return {
    async getEntryBuffer(entryPath: string): Promise<Buffer> {
      const normalizedTargetPath = entryPath.replaceAll("\\", "/");
      if (!isSecureJarEntryPath(normalizedTargetPath)) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Entry path "${normalizedTargetPath}" is not allowed.`,
          details: { jarPath, entryPath: normalizedTargetPath }
        });
      }
      const entry = index.get(normalizedTargetPath);
      if (!entry) {
        throw createError({
          code: ERROR_CODES.SOURCE_NOT_FOUND,
          message: `Entry "${normalizedTargetPath}" was not found in "${jarPath}".`,
          details: { jarPath, entryPath: normalizedTargetPath }
        });
      }
      return readEntryStream(zipFile, entry, jarPath);
    },
    close(): void {
      if (!closed) {
        closed = true;
        zipFile.close();
      }
    }
  };
}

export async function collectMatchedJarEntriesAsUtf8(
  jarPath: string,
  predicate: (entryPath: string) => boolean,
  options: CollectMatchedJarEntriesOptions = {}
): Promise<JarEntryText[]> {
  return withZipFile(jarPath, async (zipFile) => {
    const entries: JarEntryText[] = [];
    const maxEntries =
      options.maxEntries == null ? undefined : Math.max(1, Math.trunc(options.maxEntries));
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        return entries;
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (!predicate(entry.fileName)) {
        continue;
      }

      try {
        const contentBuffer = await readEntryStream(zipFile, entry, jarPath, options.maxBytes);
        entries.push({
          filePath: entry.fileName,
          content: decodeUtf8OrThrow(contentBuffer, jarPath, entry.fileName)
        });
        if (maxEntries != null && entries.length >= maxEntries) {
          return entries;
        }
      } catch (error) {
        if (!options.continueOnError) {
          throw error;
        }
      }
    }
  });
}

export interface JarEntryBuffer {
  filePath: string;
  content: Buffer;
}

/**
 * Seam for injecting the jar-open primitive so callers/tests can count opens.
 * Defaults to the module-level {@link openZipFile}.
 */
export interface JarReaderOpenDeps {
  openZipFile?: (jarPath: string) => Promise<ZipFile>;
}

/**
 * Raw-buffer counterpart of {@link collectMatchedJarEntriesAsUtf8}: opens the jar
 * ONCE and returns the matched entries as raw Buffers (no UTF-8 decode), so binary
 * inputs like `.class` bytes survive intact. Used to avoid re-opening the jar per
 * sampled entry. Mirrors the sibling's maxBytes/maxEntries/continueOnError semantics
 * and its finally-close, but takes an injectable open seam for open-count assertions.
 */
export async function collectMatchedJarEntriesAsBuffers(
  jarPath: string,
  predicate: (entryPath: string) => boolean,
  options: CollectMatchedJarEntriesOptions = {},
  deps: JarReaderOpenDeps = {}
): Promise<JarEntryBuffer[]> {
  const open = deps.openZipFile ?? openZipFile;
  const zipFile = await open(jarPath);
  try {
    const entries: JarEntryBuffer[] = [];
    const maxEntries =
      options.maxEntries == null ? undefined : Math.max(1, Math.trunc(options.maxEntries));
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        return entries;
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }
      if (!predicate(entry.fileName)) {
        continue;
      }

      try {
        const contentBuffer = await readEntryStream(zipFile, entry, jarPath, options.maxBytes);
        entries.push({ filePath: entry.fileName, content: contentBuffer });
        if (maxEntries != null && entries.length >= maxEntries) {
          return entries;
        }
      } catch (error) {
        if (!options.continueOnError) {
          throw error;
        }
      }
    }
  } finally {
    zipFile.close();
  }
}

export async function* iterateJavaEntriesAsUtf8(
  jarPath: string, maxBytes?: number
): AsyncGenerator<JavaEntryText> {
  const zipFile = await openZipFile(jarPath);
  try {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        break;
      }
      if (!hasJavaSourceExtension(entry.fileName)) {
        continue;
      }
      if (!isSecureJarEntryPath(entry.fileName)) {
        continue;
      }

      let buf: Buffer;
      try {
        buf = await readEntryStream(zipFile, entry, jarPath, maxBytes);
      } catch (err) {
        if (err instanceof EntryTooLargeError) {
          log("warn", "source_jar.entry_too_large", {
            jarPath,
            entryPath: entry.fileName,
            maxBytes
          });
          continue;
        }
        throw err;
      }
      const content = decodeUtf8OrThrow(buf, jarPath, entry.fileName);
      yield {
        filePath: entry.fileName,
        content
      };
    }
  } finally {
    zipFile.close();
  }
}

export async function readAllJavaEntriesAsUtf8(
  jarPath: string, maxBytes?: number
): Promise<JavaEntryText[]> {
  const entries: JavaEntryText[] = [];
  for await (const entry of iterateJavaEntriesAsUtf8(jarPath, maxBytes)) {
    entries.push({
      filePath: entry.filePath,
      content: entry.content
    });
  }

  return entries;
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

export async function detectFabricLikeInputNamespace(
  inputJar: string,
  deps: JarReaderOpenDeps = {}
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

  // Read all sampled class entries in a SINGLE jar open instead of re-opening the
  // jar once per entry. The sample set and latin1 decode are unchanged, so scores —
  // and therefore the detected namespace — are identical.
  const sampleSet = new Set(classEntries);
  const matched = await collectMatchedJarEntriesAsBuffers(
    inputJar,
    (name) => sampleSet.has(name),
    { continueOnError: true },
    deps
  );

  let mojangScore = 0;
  let intermediaryScore = 0;
  for (const { content } of matched) {
    const text = content.toString("latin1");
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
