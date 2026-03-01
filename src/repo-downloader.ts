import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createError, ERROR_CODES } from "./errors.js";

export interface DownloadResult {
  ok: boolean;
  statusCode?: number;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  path?: string;
}

export interface DownloadOptions {
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function retryDelay(baseMs: number, attempt: number): number {
  return Math.floor(baseMs * 2 ** attempt + Math.random() * 128);
}

export async function downloadToCache(
  url: string,
  destinationPath: string,
  opts: DownloadOptions = {}
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxRetries = opts.retries ?? 2;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  if (!isHttpUrl(url)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported scheme for download URL: ${url}`,
      details: { url }
    });
  }

  mkdirSync(dirname(destinationPath), { recursive: true });

  let attempt = 0;
  while (true) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, { signal: timeout.signal });
      clearTimeout(timer);

      const status = response.status;
      if (status === 404) {
        return { ok: false, statusCode: status };
      }

      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt >= maxRetries) {
          return { ok: false, statusCode: status };
        }

        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelay(200, attempt);
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          statusCode: status,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
          contentLength: Number.parseInt(response.headers.get("content-length") ?? "0", 10)
        };
      }

      const tempPath = `${destinationPath}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        if (!response.body) {
          writeFileSync(tempPath, Buffer.alloc(0));
        } else {
          const readable = Readable.fromWeb(response.body as unknown as any);
          await pipeline(readable, createWriteStream(tempPath));
        }

        const contentLength = statSync(tempPath).size;
        renameSync(tempPath, destinationPath);

        return {
          ok: true,
          statusCode: status,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
          contentLength,
          path: destinationPath
        };
      } catch (streamError) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort cleanup
        }
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }
    } catch (caughtError) {
      clearTimeout(timer);
      if (attempt >= maxRetries) {
        throw caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      }

      await sleep(retryDelay(200, attempt));
      attempt += 1;
    }
  }
}

export function defaultDownloadPath(cacheDir: string, url: string): string {
  const filename = `${sha256(url)}.jar`;
  return `${cacheDir}/downloads/${filename}`;
}
