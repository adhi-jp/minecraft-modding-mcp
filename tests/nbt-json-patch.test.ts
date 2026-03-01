import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { applyJsonPatch } from "../src/nbt/json-patch.ts";
import type { TypedNbtDocument } from "../src/nbt/typed-json.ts";

function buildDocument(): TypedNbtDocument {
  return {
    rootName: "Level",
    root: {
      type: "compound",
      value: {
        count: { type: "int", value: 3 },
        list: {
          type: "list",
          elementType: "int",
          value: [
            { type: "int", value: 1 },
            { type: "int", value: 2 }
          ]
        }
      }
    }
  };
}

test("applyJsonPatch applies add/replace/test/remove and returns metadata", () => {
  const source = buildDocument();
  const patch = [
    {
      op: "add",
      path: "/root/value/name",
      value: { type: "string", value: "Alex" }
    },
    {
      op: "replace",
      path: "/root/value/count/value",
      value: 7
    },
    {
      op: "test",
      path: "/root/value/count/type",
      value: "int"
    },
    {
      op: "remove",
      path: "/root/value/list/value/1"
    }
  ];

  const result = applyJsonPatch(source, patch);

  assert.equal(result.meta.appliedOps, 4);
  assert.equal(result.meta.testOps, 1);
  assert.equal(result.meta.changed, true);
  assert.equal(result.typedJson.rootName, "Level");
  assert.deepEqual((result.typedJson.root as { value: Record<string, unknown> }).value.name, {
    type: "string",
    value: "Alex"
  });
  assert.equal(
    ((result.typedJson.root as { value: { count: { value: number } } }).value.count.value),
    7
  );
  assert.equal(
    ((result.typedJson.root as { value: { list: { value: Array<{ value: number }> } } }).value.list.value.length),
    1
  );
});

test("applyJsonPatch rejects unsupported RFC6902 operations", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        {
          op: "move",
          from: "/root/value/count",
          path: "/root/value/movedCount"
        }
      ]),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.NBT_UNSUPPORTED_FEATURE
  );
});

test("applyJsonPatch enforces typed-json invariants after mutation", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        {
          op: "replace",
          path: "/root/value/count/value",
          value: "broken"
        }
      ]),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === ERROR_CODES.JSON_PATCH_CONFLICT
  );
});

test("applyJsonPatch is atomic and does not mutate input on failure", () => {
  const source = buildDocument();
  const baseline = structuredClone(source);

  assert.throws(
    () =>
      applyJsonPatch(source, [
        {
          op: "replace",
          path: "/root/value/count/value",
          value: 9
        },
        {
          op: "replace",
          path: "/root/value/count/value",
          value: "broken"
        }
      ])
  );

  assert.deepEqual(source, baseline);
});
