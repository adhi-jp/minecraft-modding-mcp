import { existsSync } from "node:fs";
import { join } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { downloadToCache } from "./repo-downloader.js";

const DEFAULT_VERSION = "0.10.3";
const DOWNLOAD_TIMEOUT_MS = 120_000;

const inflightDownloads = new Map<string, Promise<string>>();

function tinyRemapperCachePath(cacheDir: string, version: string): string {
  return join(cacheDir, "resources", `tiny-remapper-${version}-fat.jar`);
}

function tinyRemapperDownloadUrl(version: string): string {
  return `https://maven.fabricmc.net/net/fabricmc/tiny-remapper/${version}/tiny-remapper-${version}-fat.jar`;
}

export async function resolveTinyRemapperJar(
  cacheDir: string,
  overridePath: string | undefined,
  fetchFn?: typeof fetch
): Promise<string> {
  // 1. Environment / config override
  if (overridePath) {
    return overridePath;
  }

  const version = process.env.MCP_TINY_REMAPPER_VERSION ?? DEFAULT_VERSION;
  const cached = tinyRemapperCachePath(cacheDir, version);

  // 2. Already cached
  if (existsSync(cached)) {
    return cached;
  }

  // 3. Download with per-target lock
  const inflight = inflightDownloads.get(cached);
  if (inflight) {
    return inflight;
  }

  const downloadPromise = downloadTinyRemapper(version, cached, fetchFn);
  inflightDownloads.set(cached, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    inflightDownloads.delete(cached);
  }
}

async function downloadTinyRemapper(
  version: string,
  destination: string,
  fetchFn?: typeof fetch
): Promise<string> {
  const url = tinyRemapperDownloadUrl(version);

  log("info", "tiny-remapper.download.start", { version, url });

  const result = await downloadToCache(url, destination, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    retries: 2,
    ...(fetchFn ? { fetchFn } : {})
  });

  if (!result.ok || !result.path) {
    throw createError({
      code: ERROR_CODES.REMAPPER_UNAVAILABLE,
      message: `Failed to download tiny-remapper ${version} from Fabric Maven.`,
      details: { version, url, statusCode: result.statusCode }
    });
  }

  log("info", "tiny-remapper.download.done", {
    version,
    path: result.path,
    contentLength: result.contentLength
  });

  return result.path;
}
