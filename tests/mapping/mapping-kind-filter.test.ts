/**
 * A mapping lookup must only answer with candidates of the query's own kind.
 *
 * Two indexes make cross-kind matches possible: `exactLookupKeys` registers every
 * method a second time under the descriptorless `owner.name` key that a FIELD's
 * symbol also uses, and `simpleLookupKeys` files classes, fields and methods under
 * the same bare-name key. Neither `lookupCandidates` nor `findMapping` used to
 * compare kinds, so a field could be answered with a method's target name and a
 * field query could be answered with a class.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import {
  installGradleUserHomeIsolation,
  withCwd,
  createLoomService
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

// One class declaring a FIELD and a METHOD that share the obfuscated name `value`
// — the record-component / accessor shape, and what ProGuard name reuse produces.
// Both register under the descriptorless exact key `a.b.C.value`.
const TEST_FIELD_METHOD_NAME_COLLISION_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\tvalue\tinterValue\tfieldValue",
  "\tm\t()I\tvalue\tinterValueMethod\tmethodValue"
].join("\n");

// A field whose name equals another class's simple name. Both land on the bare
// `Thing` simple-name key.
const TEST_FIELD_NAMED_LIKE_CLASS_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\tThing\tinterThing\tthingField",
  "c\ta/b/Thing\tinter/pkg/InterThing\tyarn/pkg/Thing"
].join("\n");

test("MappingService findMapping kind=field ignores a same-named method on the same owner", async () => {
  const { root, service } = await createLoomService(
    "field-method-collision-",
    TEST_FIELD_METHOD_NAME_COLLISION_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "field",
        owner: "a.b.C",
        name: "value",
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.deepEqual(
      mapped.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`),
      ["field:fieldValue"],
      `a field query must not collect the method row: ${JSON.stringify(mapped.candidates)}`
    );
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "fieldValue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping kind=method ignores a same-named field on the same owner", async () => {
  const { root, service } = await createLoomService(
    "method-field-collision-",
    TEST_FIELD_METHOD_NAME_COLLISION_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "value",
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.deepEqual(
      mapped.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`),
      ["method:methodValue"],
      `a method query must not collect the field row: ${JSON.stringify(mapped.candidates)}`
    );
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "methodValue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping kind=field ignores a class sharing the field's simple name", async () => {
  const { root, service } = await createLoomService(
    "field-class-collision-",
    TEST_FIELD_NAMED_LIKE_CLASS_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "field",
        owner: "a.b.C",
        name: "Thing",
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.deepEqual(
      mapped.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`),
      ["field:thingField"],
      `a field query must not collect the class row: ${JSON.stringify(mapped.candidates)}`
    );
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "thingField");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping kind=class still resolves through the class index", async () => {
  const { root, service } = await createLoomService(
    "class-still-resolves-",
    TEST_FIELD_NAMED_LIKE_CLASS_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "a.b.Thing",
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.kind, "class");
    assert.equal(mapped.resolvedSymbol?.symbol, "yarn.pkg.Thing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
