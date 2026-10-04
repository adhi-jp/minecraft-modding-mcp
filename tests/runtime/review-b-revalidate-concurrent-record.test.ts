import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadSidecarPath, resolveCachedDownload } from "../../src/repo-downloader.ts";
import { sha256Of, writeSidecarFor } from "../helpers/download-sidecar.ts";

test("resolveCachedDownload(revalidate) adopts a concurrent winner's record on a 304 instead of writing its own over it", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-revalidate-winner-"));
  const destination = join(root, "snapshot.jar");
  const url = "https://repo.example.com/snapshot.jar";
  await writeFile(destination, "snapshot-bytes-v1");
  await writeSidecarFor(destination, {
    url,
    contentSha256: sha256Of("snapshot-bytes-v1"),
    etag: "etag-v1",
    lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"
  });

  const winnerBytes = "snapshot-bytes-v2-concurrent-write";
  let calls = 0;
  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    // A concurrent resolve of the same mutable coordinate lands its own bytes AND
    // its own record while this conditional request is in flight. This call
    // retired the v1 record before its request went out, so what sits beside the
    // file now is the winner's - written after ours, describing bytes we have
    // never seen, carrying validators fresher than the ones our 304 answers for.
    await writeFile(destination, winnerBytes);
    // Pin the mtime rather than trusting two writes to land in different
    // filesystem ticks: mtime is half of what binds a record to a set of bytes.
    const rewrittenAt = new Date(Date.now() + 5_000);
    await utimes(destination, rewrittenAt, rewrittenAt);
    await writeSidecarFor(destination, {
      url,
      contentSha256: sha256Of(winnerBytes),
      etag: "etag-v2",
      lastModified: "Tue, 02 Jan 2024 00:00:00 GMT"
    });
    return new Response(null, { status: 304, headers: { etag: "etag-v1" } });
  }) as typeof fetch;

  const result = await resolveCachedDownload(url, destination, {
    freshness: "revalidate",
    retries: 0,
    timeoutMs: 2_000,
    fetchFn
  });

  assert.equal(calls, 1, "adopting the record on disk must not cost a second transfer");
  assert.equal(result.ok, true);
  assert.equal(result.cacheStatus, "revalidated");
  assert.equal(result.contentSha256, sha256Of(winnerBytes));
  // The 304 answered for the OLD bytes, so its validators describe an entry this
  // call no longer holds. Reporting them - or writing them down - replaces the
  // winner's confirmed freshness with our own stale copy of it, and nothing in
  // the digest would show the downgrade.
  assert.equal(result.etag, "etag-v2");
  assert.equal(result.lastModified, "Tue, 02 Jan 2024 00:00:00 GMT");

  const sidecar = JSON.parse(await readFile(downloadSidecarPath(destination), "utf8"));
  assert.equal(sidecar.etag, "etag-v2", "the winner's fresher validator survives our revalidation");
  assert.equal(sidecar.contentSha256, sha256Of(winnerBytes));
  assert.equal(
    sidecar.contentMtimeMs,
    (await stat(destination)).mtimeMs,
    "and the record still describes the bytes on disk"
  );
  assert.equal(await readFile(destination, "utf8"), winnerBytes);
});
