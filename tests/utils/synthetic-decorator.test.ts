import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import type { JSONRPCResponse } from "@modelcontextprotocol/server";

import { decorateSyntheticReply } from "../../src/synthetic-decorator.ts";
import { SERVER_IDENTITY } from "../../src/server-identity.ts";

/**
 * Centralized modern-era decorator for supervisor-synthesized replies.
 * Contract: modern-era RESULT envelopes gain `resultType: "complete"` and the
 * canonical identity under `_meta[SERVER_INFO_META_KEY]`; everything else
 * (legacy/unselected eras, raw JSON-RPC error envelopes) passes through
 * UNCHANGED (same reference — legacy byte compatibility); cache fields are
 * never added.
 */

function structuredResult(id: number): JSONRPCResponse {
  const structuredContent = { error: { code: "ERR_WORKER_RESTART" }, meta: { synthetic: true } };
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      isError: true,
      structuredContent
    }
  } as unknown as JSONRPCResponse;
}

function rawError(id: number): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message: "MCP worker restarted while handling the request. Retry the request." }
  } as JSONRPCResponse;
}

test("decorates a modern-era structured result with resultType complete and the canonical identity", () => {
  const original = structuredResult(7);
  const originalJson = JSON.stringify(original);
  const decorated = decorateSyntheticReply(original, "modern") as unknown as {
    id: number;
    result: Record<string, unknown>;
  };

  assert.equal(decorated.id, 7);
  assert.equal(decorated.result.resultType, "complete");
  const meta = decorated.result._meta as Record<string, unknown>;
  assert.deepEqual(meta[SERVER_INFO_META_KEY], { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version });
  // Payload untouched.
  assert.deepEqual(decorated.result.structuredContent, (original as unknown as { result: { structuredContent: unknown } }).result.structuredContent);
  assert.equal(decorated.result.isError, true);
  // The input reply object is never mutated.
  assert.equal(JSON.stringify(original), originalJson, "decoration must not mutate its input");
});

test("returns legacy-era and unselected-era replies unchanged by reference", () => {
  const structured = structuredResult(1);
  assert.equal(decorateSyntheticReply(structured, "legacy"), structured, "legacy replies must pass through by reference (byte-identical)");
  assert.equal(decorateSyntheticReply(structured, "unselected"), structured, "unselected replies must pass through by reference");
  assert.equal(decorateSyntheticReply(structured, undefined), structured, "era-less snapshots must pass through by reference");
});

test("returns raw JSON-RPC error envelopes unchanged by reference in every era", () => {
  const raw = rawError(2);
  assert.equal(decorateSyntheticReply(raw, "modern"), raw, "raw error envelopes gain NO result-only fields even in the modern era");
  assert.equal(decorateSyntheticReply(raw, "legacy"), raw);
  const serialized = JSON.stringify(decorateSyntheticReply(raw, "modern"));
  assert.equal(serialized.includes("resultType"), false);
  assert.equal(serialized.includes(SERVER_INFO_META_KEY), false);
});

test("never adds cache fields to a decorated result", () => {
  const decorated = decorateSyntheticReply(structuredResult(3), "modern") as unknown as {
    result: Record<string, unknown>;
  };
  assert.equal("ttlMs" in decorated.result, false, "ttlMs belongs only to the cacheable list/read/discover methods");
  assert.equal("cacheScope" in decorated.result, false, "cacheScope belongs only to the cacheable list/read/discover methods");
  const meta = decorated.result._meta as Record<string, unknown>;
  assert.equal("ttlMs" in meta, false);
  assert.equal("cacheScope" in meta, false);
});

test("stamps an independent identity copy and preserves pre-existing result _meta keys", () => {
  const withMeta = {
    jsonrpc: "2.0",
    id: 4,
    result: {
      content: [],
      isError: true,
      structuredContent: {},
      _meta: { "app/custom": 1 }
    }
  } as unknown as JSONRPCResponse;
  const decorated = decorateSyntheticReply(withMeta, "modern") as unknown as {
    result: { _meta: Record<string, unknown> };
  };
  assert.equal(decorated.result._meta["app/custom"], 1, "pre-existing _meta keys must be preserved");

  const stamped = decorated.result._meta[SERVER_INFO_META_KEY] as { name: string; version: string };
  assert.deepEqual(stamped, { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version });
  assert.notEqual(stamped, SERVER_IDENTITY, "the stamped identity must be a copy, not the frozen module constant");
  stamped.name = "mutated";
  assert.notEqual(SERVER_IDENTITY.name, "mutated", "mutating a stamped identity must not corrupt the canonical identity");
  const again = decorateSyntheticReply(structuredResult(5), "modern") as unknown as {
    result: { _meta: Record<string, unknown> };
  };
  assert.deepEqual(again.result._meta[SERVER_INFO_META_KEY], { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version });
});
