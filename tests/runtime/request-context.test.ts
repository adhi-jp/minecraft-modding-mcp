import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { SourceService } from "../../src/source-service.ts";
import {
  getRequestContext,
  runWithRequestContext,
  type RequestContext
} from "../../src/request-context.ts";
import {
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";

// The in-process session serves buildServer() from ../../src/index.ts over
// the public transport; sourceService is a module singleton shared by every
// server instance, so the SourceService.prototype monkey-patch below is
// observed identically over the wire.
let session: InProcessSession;

before(async () => {
  session = await startInProcessSession();
  const handshake = await legacyHandshake(session, undefined, "request-context-init");
  assert.equal(handshake.error, undefined);
});

after(async () => {
  await session?.close();
});

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
    const frame = await session.request({
      jsonrpc: "2.0",
      id: "request-context-call",
      method: "tools/call",
      params: { name: "list-versions", arguments: {} }
    });
    assert.equal(frame.error, undefined, "tools/call must answer a result frame, not a JSON-RPC error frame");
    const response = frame.result as {
      structuredContent?: { meta?: { requestId?: string } };
    };

    assert.ok(observedContext);
    assert.equal(observedContext.requestId, response.structuredContent?.meta?.requestId);
  } finally {
    SourceService.prototype.listVersions = originalListVersions;
  }
});
