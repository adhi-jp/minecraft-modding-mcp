import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { applyJsonPatch } from "../../src/nbt/json-patch.ts";
import type { TypedNbtDocument } from "../../src/nbt/typed-json.ts";

import { expectAppErrorCode } from "../helpers/expect-app-error.ts";

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
    expectAppErrorCode(ERROR_CODES.NBT_UNSUPPORTED_FEATURE)
  );
});

test("applyJsonPatch rejects copy operations as unsupported", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        {
          op: "copy",
          from: "/root/value/count",
          path: "/root/value/copiedCount"
        }
      ]),
    expectAppErrorCode(ERROR_CODES.NBT_UNSUPPORTED_FEATURE)
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
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
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

test("applyJsonPatch rejects a patch that is not an array", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, { op: "add", path: "/root/value/x", value: 1 }),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch rejects an operation that is not an object", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, ["not-an-object"]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch rejects operations with a non-string op or path", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: 5, path: "/root/value/count" }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );

  assert.throws(
    () => applyJsonPatch(source, [{ op: "add", path: 5, value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch rejects an unsupported operation name", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "foo", path: "/root/value/count", value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch rejects add/replace/test operations missing value", () => {
  const source = buildDocument();

  for (const op of ["add", "replace", "test"] as const) {
    assert.throws(
      () => applyJsonPatch(source, [{ op, path: "/root/value/count/value" }]),
      expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID),
      `expected JSON_PATCH_INVALID for ${op} missing value`
    );
  }
});

test("applyJsonPatch rejects a non-rooted JSON Pointer", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "test", path: "root/value", value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch rejects an invalid JSON Pointer escape sequence", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "test", path: "/~2", value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_INVALID)
  );
});

test("applyJsonPatch appends to an array via the \"-\" token", () => {
  const source = buildDocument();

  const result = applyJsonPatch(source, [
    { op: "add", path: "/root/value/list/value/-", value: { type: "int", value: 9 } }
  ]);

  const list = (result.typedJson.root as { value: { list: { value: Array<{ value: number }> } } })
    .value.list.value;
  assert.equal(list.length, 3);
  assert.equal(list[2].value, 9);
  assert.equal(result.meta.changed, true);
});

test("applyJsonPatch inserts into an array at an existing index", () => {
  const source = buildDocument();

  const result = applyJsonPatch(source, [
    { op: "add", path: "/root/value/list/value/0", value: { type: "int", value: 99 } }
  ]);

  const list = (result.typedJson.root as { value: { list: { value: Array<{ value: number }> } } })
    .value.list.value;
  assert.equal(list.length, 3);
  assert.equal(list[0].value, 99);
  assert.equal(list[1].value, 1);
});

test("applyJsonPatch rejects the \"-\" array token for non-add operations", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "remove", path: "/root/value/list/value/-" }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch rejects a non-numeric array index", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        { op: "replace", path: "/root/value/list/value/x", value: { type: "int", value: 1 } }
      ]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch rejects an out-of-bounds array add index", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        { op: "add", path: "/root/value/list/value/5", value: { type: "int", value: 1 } }
      ]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch rejects out-of-bounds replace/remove/test array indices", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        { op: "replace", path: "/root/value/list/value/5", value: { type: "int", value: 1 } }
      ]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );

  assert.throws(
    () => applyJsonPatch(source, [{ op: "remove", path: "/root/value/list/value/5" }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );

  assert.throws(
    () => applyJsonPatch(source, [{ op: "test", path: "/root/value/list/value/5", value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch supports add and replace targeting the document root", () => {
  const added = applyJsonPatch(buildDocument(), [
    { op: "add", path: "", value: { rootName: "Added", root: { type: "byte", value: 1 } } }
  ]);
  assert.equal(added.typedJson.rootName, "Added");
  assert.deepEqual(added.typedJson.root, { type: "byte", value: 1 });
  assert.equal(added.meta.changed, true);

  const replaced = applyJsonPatch(buildDocument(), [
    { op: "replace", path: "", value: { rootName: "Replaced", root: { type: "short", value: 7 } } }
  ]);
  assert.equal(replaced.typedJson.rootName, "Replaced");
  assert.deepEqual(replaced.typedJson.root, { type: "short", value: 7 });
});

test("applyJsonPatch rejects removing the document root", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "remove", path: "" }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch rejects replace/remove on a non-existent key", () => {
  const source = buildDocument();

  assert.throws(
    () =>
      applyJsonPatch(source, [
        { op: "replace", path: "/root/value/missing", value: { type: "int", value: 1 } }
      ]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );

  assert.throws(
    () => applyJsonPatch(source, [{ op: "remove", path: "/root/value/missing" }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});

test("applyJsonPatch rejects traversal into a non-container value", () => {
  const source = buildDocument();

  assert.throws(
    () => applyJsonPatch(source, [{ op: "test", path: "/root/value/count/value/x", value: 1 }]),
    expectAppErrorCode(ERROR_CODES.JSON_PATCH_CONFLICT)
  );
});
