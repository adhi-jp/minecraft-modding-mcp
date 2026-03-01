import { existsSync } from "node:fs";
import { join } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { downloadToCache } from "./repo-downloader.js";

const DEFAULT_VERSION = "1.11.2";
const DOWNLOAD_TIMEOUT_MS = 120_000;

const inflightDownloads = new Map<string, Promise<string>>();

function vineflowerCachePath(cacheDir: string, version: string): string {
  return join(cacheDir, "resources", `vineflower-${version}.jar`);
}

function vineflowerDownloadUrl(version: string): string {
  return `https://github.com/Vineflower/vineflower/releases/download/${version}/vineflower-${version}.jar`;
}

export async function resolveVineflowerJar(
  cacheDir: string,
  overridePath: string | undefined,
  fetchFn?: typeof fetch
): Promise<string> {
  // 1. Environment / config override
  if (overridePath) {
    return overridePath;
  }

  const version = process.env.MCP_VINEFLOWER_VERSION ?? DEFAULT_VERSION;
  const cached = vineflowerCachePath(cacheDir, version);

  // 2. Already cached
  if (existsSync(cached)) {
    return cached;
  }

  // 3. Download with per-target lock
  const inflight = inflightDownloads.get(cached);
  if (inflight) {
    return inflight;
  }

  const downloadPromise = downloadVineflower(version, cached, fetchFn);
  inflightDownloads.set(cached, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    inflightDownloads.delete(cached);
  }
}

async function downloadVineflower(
  version: string,
  destination: string,
  fetchFn?: typeof fetch
): Promise<string> {
  const url = vineflowerDownloadUrl(version);

  log("info", "vineflower.download.start", { version, url });

  const result = await downloadToCache(url, destination, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    retries: 2,
    ...(fetchFn ? { fetchFn } : {})
  });

  if (!result.ok || !result.path) {
    throw createError({
      code: ERROR_CODES.DECOMPILER_UNAVAILABLE,
      message: `Failed to download Vineflower ${version} from GitHub.`,
      details: { version, url, statusCode: result.statusCode }
    });
  }

  log("info", "vineflower.download.done", {
    version,
    path: result.path,
    contentLength: result.contentLength
  });

  return result.path;
}
