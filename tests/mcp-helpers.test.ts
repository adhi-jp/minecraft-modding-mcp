import assert from "node:assert/strict";
import test from "node:test";

import { objectResult } from "../src/mcp-helpers.ts";

test("objectResult mirrors JSON envelopes into structuredContent", () => {
  const payload = {
    result: {
      ok: true
    },
    meta: {
      requestId: "req-1",
      tool: "demo",
      durationMs: 1,
      warnings: []
    }
  };

  const result = objectResult(payload);

  assert.deepEqual(result.structuredContent, payload);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(payload) }]);
});

test("objectResult marks MCP errors with isError", () => {
  const payload = {
    error: {
      code: "ERR_INVALID_INPUT",
      detail: "bad input"
    },
    meta: {
      requestId: "req-2",
      tool: "demo",
      durationMs: 2,
      warnings: []
    }
  };

  const result = objectResult(payload, { isError: true });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, payload);
});
