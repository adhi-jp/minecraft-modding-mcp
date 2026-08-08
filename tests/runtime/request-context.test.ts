import assert from "node:assert/strict";
import test from "node:test";

import { SourceService } from "../../src/source-service.ts";
import {
  getRequestContext,
  runWithRequestContext,
  type RequestContext
} from "../../src/request-context.ts";
import { server } from "../../src/index.ts";

type RequestHandler = (
  request: { jsonrpc: string; id: number; method: string; params: Record<string, unknown> },
  extra: Record<string, unknown>
) => Promise<unknown>;

const callToolHandler = (
  server.server as { _requestHandlers: Map<string, RequestHandler> }
)._requestHandlers.get("tools/call");
assert.ok(callToolHandler);

test("getRequestContext returns undefined outside a request context", () => {
  assert.equal(getRequestContext(), undefined);
});

test("runWithRequestContext propagates context across await boundaries", async () => {
  const context: RequestContext = { requestId: "request-across-awaits" };

  await runWithRequestContext(context, async () => {
    await Promise.resolve();
    assert.equal(getRequestContext(), context);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(getRequestContext(), context);
  });
});

test("nested request contexts restore the outer context", async () => {
  const outer: RequestContext = { requestId: "outer" };
  const inner: RequestContext = { requestId: "inner" };

  await runWithRequestContext(outer, async () => {
    assert.equal(getRequestContext(), outer);
    await runWithRequestContext(inner, async () => {
      await Promise.resolve();
      assert.equal(getRequestContext(), inner);
    });
    assert.equal(getRequestContext(), outer);
  });
});

test("concurrent request contexts do not leak into each other", async () => {
  const observe = async (requestId: string, delayMs: number): Promise<string | undefined> =>
    runWithRequestContext({ requestId }, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      await Promise.resolve();
      return getRequestContext()?.requestId;
    });

  assert.deepEqual(
    await Promise.all([observe("request-a", 5), observe("request-b", 0)]),
    ["request-a", "request-b"]
  );
});

test("tool actions observe the requestId emitted in response metadata", async () => {
  let observedContext: RequestContext | undefined;
  const originalListVersions = SourceService.prototype.listVersions;
  SourceService.prototype.listVersions = async () => {
    observedContext = getRequestContext();
    return { latest: {}, releases: [], cached: [], totalAvailable: 0 };
  };

  try {
    const response = await callToolHandler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list-versions", arguments: {} }
    }, {
      // Minimal v2 ServerContext stand-in: the v2 handler wrapper reads
      // ctx.mcpReq (requestState()/signal) unconditionally, so the v1-era `{}`
      // extra no longer drives the SDK-internal handler.
      mcpReq: {
        id: 1,
        method: "tools/call",
        requestState: () => undefined,
        signal: new AbortController().signal,
        notify: async () => {},
        log: async () => {}
      }
    }) as {
      structuredContent?: { meta?: { requestId?: string } };
    };

    assert.ok(observedContext);
    assert.equal(observedContext.requestId, response.structuredContent?.meta?.requestId);
  } finally {
    SourceService.prototype.listVersions = originalListVersions;
  }
});
