import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { ToolExecutionGate } from "../src/tool-execution-gate.ts";

test("ToolExecutionGate serializes heavy jobs with concurrency 1", async () => {
  const gate = new ToolExecutionGate({ maxConcurrent: 1, maxQueue: 2 });
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | undefined;

  const first = gate.run("trace-symbol-lifecycle", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
    active -= 1;
    return "first";
  });

  const second = gate.run("compare-versions", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push("second:start");
    active -= 1;
    events.push("second:end");
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);

  releaseFirst?.();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results, ["first", "second"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("ToolExecutionGate rejects overflow instead of starting more heavy jobs", async () => {
  const gate = new ToolExecutionGate({ maxConcurrent: 1, maxQueue: 0 });
  let releaseFirst: (() => void) | undefined;

  const first = gate.run("trace-symbol-lifecycle", async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () =>
      gate.run("compare-versions", async () => {
        throw new Error("should not run");
      }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.equal(error !== null && "code" in error ? (error as { code?: string }).code : undefined, ERROR_CODES.LIMIT_EXCEEDED);
      const details = error && typeof error === "object" && "details" in error
        ? (error as { details?: Record<string, unknown> }).details
        : undefined;
      assert.equal(details?.tool, "compare-versions");
      assert.match(String(details?.nextAction ?? ""), /retry/i);
      return true;
    }
  );

  releaseFirst?.();
  await first;
});
