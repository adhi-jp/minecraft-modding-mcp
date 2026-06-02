import assert from "node:assert/strict";
import test from "node:test";

import { sliceMembersWithLimit } from "../src/source/class-source/members-builder.ts";
import type { SignatureMember } from "../src/minecraft-explorer-service.ts";

function member(name: string): SignatureMember {
  return {
    ownerFqn: "com.example.X",
    name,
    javaSignature: `public void ${name}()`,
    jvmDescriptor: "()V",
    accessFlags: 0x0001,
    isSynthetic: false
  } as SignatureMember;
}

test("sliceMembersWithLimit: offset at or past total returns empty with no self-referential continuation", () => {
  const remapped = { constructors: [], fields: [], methods: [member("a"), member("b"), member("c")] };

  const atEnd = sliceMembersWithLimit(remapped, 3, 2, [], 3);
  assert.equal(atEnd.returnedTotal, 0);
  assert.equal(atEnd.truncated, false);
  assert.equal(atEnd.nextOffset, undefined);

  // A stale/oversized offset must clamp, not loop with consumed > total.
  const past = sliceMembersWithLimit(remapped, 3, 2, [], 9);
  assert.equal(past.returnedTotal, 0);
  assert.equal(past.truncated, false);
  assert.equal(past.nextOffset, undefined);
});

test("sliceMembersWithLimit: empty member set returns empty with no continuation", () => {
  const result = sliceMembersWithLimit({ constructors: [], fields: [], methods: [] }, 0, 5, [], 0);
  assert.equal(result.returnedTotal, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.nextOffset, undefined);
});

test("sliceMembersWithLimit: final partial page advertises no continuation", () => {
  const remapped = { constructors: [], fields: [], methods: [member("a"), member("b"), member("c")] };
  const lastPage = sliceMembersWithLimit(remapped, 3, 2, [], 2);
  assert.deepEqual(lastPage.methods.map((m) => m.name), ["c"]);
  assert.equal(lastPage.truncated, false);
  assert.equal(lastPage.nextOffset, undefined);
});

test("sliceMembersWithLimit: a full page short of the end reports nextOffset for continuation", () => {
  const remapped = { constructors: [member("ctor")], fields: [member("f")], methods: [member("a"), member("b")] };
  const firstPage = sliceMembersWithLimit(remapped, 4, 2, [], 0);
  assert.deepEqual(firstPage.constructors.map((m) => m.name), ["ctor"]);
  assert.deepEqual(firstPage.fields.map((m) => m.name), ["f"]);
  assert.equal(firstPage.methods.length, 0);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.nextOffset, 2);
});
