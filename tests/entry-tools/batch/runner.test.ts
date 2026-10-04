import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES } from "../../../src/errors.ts";
import { runBatch } from "../../../src/entry-tools/batch-runner.ts";

type Entry = { id: string; fail?: boolean };

test("runBatch failFast=false keeps running after a per-entry failure and preserves the underlying code", async () => {
  const seen: string[] = [];
  const out = await runBatch<Entry, { id: string }, { artifactId: string }>({
    entries: [{ id: "a" }, { id: "b", fail: true }, { id: "c" }],
    concurrency: 1,
    failFast: false,
    resolveSharedArtifact: async () => ({ artifactId: "shared" }),
    perEntry: async (entry) => {
      seen.push(entry.id);
      if (entry.fail) {
        throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: `boom: ${entry.id}` });
      }
      return { result: { id: entry.id } };
    },
    buildErrorSuggestedCall: () => undefined
  });

  // Every entry was dispatched (the failure did not abort the batch).
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.ok, 2);
  assert.equal(out.summary.error, 1);
  for (let i = 0; i < 3; i++) assert.equal(out.results[i]!.index, i);
  assert.equal(out.results[0]!.status, "ok");
  assert.equal(out.results[1]!.status, "error");
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.equal(out.results[2]!.status, "ok");
});

test("runBatch failFast=true aborts un-started entries with ERR_BATCH_ABORTED", async () => {
  // concurrency=1 makes the test deterministic: no later entry can start until
  // entry 0 returns its (failed) result, so all subsequent entries are
  // guaranteed un-started when the abort flag flips.
  const out = await runBatch<Entry, { id: string }, undefined>({
    entries: [{ id: "fail", fail: true }, { id: "b" }, { id: "c" }],
    concurrency: 1,
    failFast: true,
    resolveSharedArtifact: async () => undefined,
    perEntry: async (entry) => {
      if (entry.fail) {
        throw createError({ code: ERROR_CODES.MAPPING_UNAVAILABLE, message: "boom" });
      }
      return { result: { id: entry.id } };
    },
    buildErrorSuggestedCall: () => undefined
  });

  assert.equal(out.results[0]!.status, "error");
  assert.equal((out.results[0] as { error: { code: string } }).error.code, ERROR_CODES.MAPPING_UNAVAILABLE);
  assert.equal((out.results[1] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal((out.results[2] as { error: { code: string } }).error.code, ERROR_CODES.BATCH_ABORTED);
  assert.equal(out.summary.ok, 0);
  assert.equal(out.summary.error, 3);
});

test("runBatch resolves the shared artifact exactly once and runs perEntry once per entry", async () => {
  let resolveCount = 0;
  const seen: string[] = [];
  const out = await runBatch<Entry, { id: string }, { artifactId: string }>({
    entries: [{ id: "a" }, { id: "b" }, { id: "c" }],
    concurrency: 2,
    failFast: false,
    resolveSharedArtifact: async () => {
      resolveCount += 1;
      return { artifactId: "shared" };
    },
    perEntry: async (entry, _index, sharedArtifact) => {
      seen.push(entry.id);
      // The one resolved artifact is threaded into every per-entry call.
      assert.equal(sharedArtifact?.artifactId, "shared");
      return { result: { id: entry.id } };
    },
    buildErrorSuggestedCall: () => undefined
  });

  assert.equal(resolveCount, 1);
  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.ok, 3);
});

test("runBatch attaches the synthesized per-entry suggestedCall to a failed entry", async () => {
  const out = await runBatch<Entry, { id: string }, undefined>({
    entries: [{ id: "boom", fail: true }],
    concurrency: 1,
    failFast: false,
    resolveSharedArtifact: async () => undefined,
    perEntry: async (entry) => {
      if (entry.fail) {
        throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "boom" });
      }
      return { result: { id: entry.id } };
    },
    buildErrorSuggestedCall: (entry) => ({ tool: "demo-tool", params: { id: entry.id } })
  });

  assert.equal(out.results[0]!.status, "error");
  const error = (out.results[0] as { error: { suggestedCall?: { tool: string; params: Record<string, unknown> } } }).error;
  assert.deepEqual(error.suggestedCall, { tool: "demo-tool", params: { id: "boom" } });
});
