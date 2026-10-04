import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";

import { downloadSidecarPath } from "../../src/repo-downloader.ts";

export function sha256Of(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The sidecar schema this build writes and is willing to read. Pinned here so a
 * fixture that hand-writes a record cannot silently drift out of the schema the
 * reader accepts - and so the deliberately-foreign-version fixtures stay
 * obviously foreign.
 */
export const CURRENT_SIDECAR_VERSION = 2;

/**
 * Write the identity record `resolveCachedDownload` would have left beside
 * `destination`, stamped with the file's real size and mtime.
 *
 * A record binds an identity to one specific set of bytes, and it is the size
 * *and* the mtime that pin it to them. A fixture has to stamp it the same way
 * the implementation does, or it is simply a record the reader is right to
 * reject - which would make the fixture prove nothing.
 */
export async function writeSidecarFor(
  destination: string,
  record: {
    url: string;
    contentSha256: string;
    contentLength?: number;
    etag?: string;
    lastModified?: string;
  }
): Promise<void> {
  const stats = await stat(destination);
  await writeFile(
    downloadSidecarPath(destination),
    JSON.stringify({
      version: CURRENT_SIDECAR_VERSION,
      url: record.url,
      contentSha256: record.contentSha256,
      contentLength: record.contentLength ?? stats.size,
      contentMtimeMs: stats.mtimeMs,
      ...(record.etag === undefined ? {} : { etag: record.etag }),
      ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified })
    })
  );
}
