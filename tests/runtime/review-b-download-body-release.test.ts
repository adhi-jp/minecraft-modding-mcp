import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadToCache } from "../../src/repo-downloader.ts";

/**
 * A body that records whether anything released it.
 *
 * `highWaterMark: 0` keeps the stream from pulling a chunk eagerly at
 * construction, so `cancelled` answers only for what production code did.
 */
function trackedBody(): { body: ReadableStream<Uint8Array>; state: { cancelled: boolean } } {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        state.cancelled = true;
      }
    },
    { highWaterMark: 0 }
  );
  return { body, state };
}

test("downloadToCache releases the body of a 404 instead of leaving it holding the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-release-404-"));
  const { body, state } = trackedBody();
  const fetchFn: typeof fetch = (async () =>
    new Response(body, { status: 404 })) as typeof fetch;

  const result = await downloadToCache(
    "https://repo.example.com/missing.jar",
    join(root, "missing.jar"),
    { retries: 0, timeoutMs: 2_000, fetchFn }
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  // A 404 body is an error page nothing here reads. Left unread it pins its
  // connection until GC gets to it, which on a pooled agent is a socket the next
  // repository in the failover loop cannot have.
  assert.equal(state.cancelled, true, "the unread 404 body must be released");
});

test("downloadToCache releases each retried 5xx body before sleeping", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-release-retry-"));
  const first = trackedBody();
  const exhausted = trackedBody();
  let calls = 0;
  const fetchFn: typeof fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(first.body, { status: 503 });
    }
    return new Response(exhausted.body, { status: 503 });
  }) as typeof fetch;

  const result = await downloadToCache(
    "https://repo.example.com/flaky.jar",
    join(root, "flaky.jar"),
    { retries: 1, timeoutMs: 2_000, fetchFn }
  );

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  // The retry leg is the worst place to hold a body: the call then sleeps, so
  // the socket stays pinned for the whole backoff and the retry that follows
  // competes with the response it is retrying.
  assert.equal(first.state.cancelled, true, "the retried body must be released before the backoff");
  assert.equal(
    exhausted.state.cancelled,
    true,
    "and so must the last one, when the retries run out"
  );
});

test("downloadToCache releases the body of a generic failure status", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-b-release-403-"));
  const { body, state } = trackedBody();
  const fetchFn: typeof fetch = (async () =>
    new Response(body, { status: 403 })) as typeof fetch;

  const result = await downloadToCache(
    "https://repo.example.com/forbidden.jar",
    join(root, "forbidden.jar"),
    { retries: 0, timeoutMs: 2_000, fetchFn }
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(state.cancelled, true, "the unread 403 body must be released");
});
