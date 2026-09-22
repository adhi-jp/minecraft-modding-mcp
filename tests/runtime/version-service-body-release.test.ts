import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import { VersionService } from "../../src/version-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/**
 * Regression: fetchJson threw on a non-OK manifest/detail response without
 * releasing the body, unlike repo-downloader's releaseBody. The unread error
 * page then pinned its connection until GC got to it, which on a pooled agent
 * is a socket the next request cannot have.
 *
 * `highWaterMark: 0` keeps the stream from pulling a chunk at construction, so
 * `cancelled` answers only for what production code did.
 */
function trackedBody(onCancel?: () => void): {
  body: ReadableStream<Uint8Array>;
  state: { cancelled: boolean };
} {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        state.cancelled = true;
        onCancel?.();
      }
    },
    { highWaterMark: 0 }
  );
  return { body, state };
}

test("VersionService releases the body of a non-OK manifest response", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-release-"));
  const { body, state } = trackedBody();
  const svc = new VersionService(
    buildTestConfig(root, { fetchTimeoutMs: 2_000 }),
    (async () => new Response(body, { status: 503 })) as typeof fetch
  );

  await assert.rejects(
    () => svc.listVersions(),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.code, ERROR_CODES.REPO_FETCH_FAILED);
      assert.equal(error.details?.statusCode, 503);
      return true;
    }
  );

  assert.equal(state.cancelled, true, "the unread error body must be released");
});

test("VersionService keeps the status error when releasing the body fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-release-throws-"));
  const { body, state } = trackedBody(() => {
    throw new Error("cancel refused");
  });
  const svc = new VersionService(
    buildTestConfig(root, { fetchTimeoutMs: 2_000 }),
    (async () => new Response(body, { status: 404 })) as typeof fetch
  );

  await assert.rejects(
    () => svc.listVersions(),
    (error: unknown) => {
      // The release is a courtesy; the status is the answer the caller needs.
      assert.ok(isAppError(error));
      assert.equal(error.code, ERROR_CODES.REPO_FETCH_FAILED);
      assert.match(error.message, /status 404/);
      return true;
    }
  );

  assert.equal(state.cancelled, true);
});
