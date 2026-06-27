import assert from "node:assert/strict";
import test from "node:test";

import { sliceMembersWithLimit, projectMembersByLevel } from "../src/source/class-source/members-builder.ts";
import type { WireMembersBlock } from "../src/source/class-source/members-builder.ts";
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

function wireBlock(): WireMembersBlock {
  return {
    ownerFqn: "com.example.Block",
    constructors: [
      { name: "<init>", javaSignature: "public Block()", jvmDescriptor: "()V" }
    ],
    fields: [
      { name: "id", javaSignature: "private int id", jvmDescriptor: "I", isSynthetic: true }
    ],
    methods: [
      { name: "canSurvive", javaSignature: "public boolean canSurvive()", jvmDescriptor: "()Z" }
    ]
  };
}

test("projectMembersByLevel: full returns the block unchanged (equivalence)", () => {
  const block = wireBlock();
  const projected = projectMembersByLevel(block, "full");
  assert.equal(projected, block); // same reference: byte-identical output
  assert.deepEqual(projected, wireBlock());
});

test("projectMembersByLevel: signatures keeps javaSignature, drops jvmDescriptor", () => {
  const projected = projectMembersByLevel(wireBlock(), "signatures");
  assert.deepEqual(projected, {
    ownerFqn: "com.example.Block",
    constructors: [{ name: "<init>", javaSignature: "public Block()" }],
    fields: [{ name: "id", javaSignature: "private int id", isSynthetic: true }],
    methods: [{ name: "canSurvive", javaSignature: "public boolean canSurvive()" }]
  });
  // no jvmDescriptor anywhere
  const all = [
    ...projected.constructors,
    ...projected.fields,
    ...projected.methods
  ];
  assert.ok(all.every((m) => !("jvmDescriptor" in m)));
});

test("projectMembersByLevel: names keeps only member name (+ block ownerFqn)", () => {
  const projected = projectMembersByLevel(wireBlock(), "names");
  assert.deepEqual(projected, {
    ownerFqn: "com.example.Block",
    constructors: [{ name: "<init>" }],
    fields: [{ name: "id" }],
    methods: [{ name: "canSurvive" }]
  });
});

test("projectMembersByLevel: preserves per-member ownerFqn in the multi-owner case", () => {
  const block: WireMembersBlock = {
    constructors: [],
    fields: [],
    methods: [
      { name: "tick", javaSignature: "public void tick()", jvmDescriptor: "()V", ownerFqn: "com.example.A" },
      { name: "load", javaSignature: "public void load()", jvmDescriptor: "()V", ownerFqn: "com.example.B" }
    ]
  };
  const names = projectMembersByLevel(block, "names");
  assert.deepEqual(names.methods, [
    { name: "tick", ownerFqn: "com.example.A" },
    { name: "load", ownerFqn: "com.example.B" }
  ]);
  const sigs = projectMembersByLevel(block, "signatures");
  assert.deepEqual(sigs.methods, [
    { name: "tick", javaSignature: "public void tick()", ownerFqn: "com.example.A" },
    { name: "load", javaSignature: "public void load()", ownerFqn: "com.example.B" }
  ]);
});
