import type { Readable } from "node:stream";

import * as yauzl from "yauzl";
import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { isSecureJarEntryPath } from "./path-resolver.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ZipEntry {
  fileName: string;
}

interface ZipFile {
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

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function hasJavaSourceExtension(entryPath: string): boolean {
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

function openZipFile(jarPath: string): Promise<ZipFile> {
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
