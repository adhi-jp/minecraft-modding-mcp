import assert from "node:assert/strict";
import test from "node:test";

test("mapWithConcurrencyLimit preserves input order while respecting the concurrency cap", async () => {
  const { mapWithConcurrencyLimit } = await import("../../src/concurrency.ts");

  let active = 0;
  let maxActive = 0;
  const visited: number[] = [];

  const result = await mapWithConcurrencyLimit([0, 1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 10 : 1));
    visited.push(value);
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [0, 10, 20, 30, 40]);
  assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);
  assert.notDeepEqual(visited, [0, 1, 2, 3, 4]);
});

test("mapWithConcurrencyLimit rejects invalid limits", async () => {
  const { mapWithConcurrencyLimit } = await import("../../src/concurrency.ts");

  await assert.rejects(
    () => mapWithConcurrencyLimit([1], 0, async (value) => value),
    /limit must be a positive integer/
  );
});
