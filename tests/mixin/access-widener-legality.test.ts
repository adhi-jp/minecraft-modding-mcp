import assert from "node:assert/strict";
import test from "node:test";

import { parseAccessWidener } from "../../src/access-widener-parser.ts";
import { validateParsedAccessWidener } from "../../src/mixin/access-validators.ts";
import type { ResolvedTargetMembers } from "../../src/mixin/types.ts";

function membersFor(
  className: string,
  overrides: Partial<ResolvedTargetMembers> = {}
): Map<string, ResolvedTargetMembers> {
  const map = new Map<string, ResolvedTargetMembers>();
  map.set(className, {
    className,
    classAccessFlags: 0x0021,
    constructors: [],
    methods: [],
    fields: [],
    ...overrides
  });
  return map;
}

test("mutable class is an illegal pairing and makes the file invalid", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v2 intermediary", "mutable class net/minecraft/server/MinecraftServer"].join("\n")
  );
  const result = validateParsedAccessWidener(parsed, membersFor("net.minecraft.server.MinecraftServer"), []);
  assert.equal(result.valid, false, "mutable class is illegal (mutable only applies to field)");
  const entry = result.entries[0];
  assert.equal(entry?.valid, false);
  assert.match(entry?.issue ?? "", /line 2/i);
  assert.match(entry?.issue ?? "", /mutable/i);
});

test("mutable method is an illegal pairing and makes the file invalid", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v2 intermediary", "mutable method net/minecraft/server/MinecraftServer tick ()V"].join("\n")
  );
  const result = validateParsedAccessWidener(parsed, membersFor("net.minecraft.server.MinecraftServer"), []);
  assert.equal(result.valid, false, "mutable method is illegal (mutable only applies to field)");
  assert.equal(result.entries[0]?.valid, false);
  assert.match(result.entries[0]?.issue ?? "", /line 2/i);
});

test("extendable field is an illegal pairing and makes the file invalid", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v2 intermediary", "extendable field net/minecraft/server/MinecraftServer running Z"].join("\n")
  );
  const result = validateParsedAccessWidener(parsed, membersFor("net.minecraft.server.MinecraftServer"), []);
  assert.equal(result.valid, false, "extendable field is illegal (extendable only applies to class/method)");
  assert.equal(result.entries[0]?.valid, false);
  assert.match(result.entries[0]?.issue ?? "", /line 2/i);
});

test("a transitive- entry under a v1 header is illegal", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v1 intermediary", "transitive-accessible class net/minecraft/server/MinecraftServer"].join("\n")
  );
  const result = validateParsedAccessWidener(parsed, membersFor("net.minecraft.server.MinecraftServer"), []);
  assert.equal(result.valid, false, "transitive- only exists in v2");
  assert.equal(result.entries[0]?.valid, false);
  assert.match(result.entries[0]?.issue ?? "", /transitive/i);
});

test("an unsupported header version makes the file invalid", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v3 intermediary", "accessible class net/minecraft/server/MinecraftServer"].join("\n")
  );
  const result = validateParsedAccessWidener(parsed, membersFor("net.minecraft.server.MinecraftServer"), []);
  assert.equal(result.valid, false, "v3 is not a supported accessWidener header version");
  assert.ok(
    result.warnings.some((w) => /line 1/i.test(w) && /v1|v2/i.test(w)),
    `expected the unsupported-version warning to name the header line and the v1/v2 rule, got: ${JSON.stringify(result.warnings)}`
  );
});

test("legal v2 transitive entries stay valid", () => {
  const parsed = parseAccessWidener(
    [
      "accessWidener v2 intermediary",
      "transitive-accessible class net/minecraft/server/MinecraftServer",
      "transitive-extendable method net/minecraft/server/MinecraftServer tick ()V",
      "transitive-mutable field net/minecraft/server/MinecraftServer running Z"
    ].join("\n")
  );
  const members = membersFor("net.minecraft.server.MinecraftServer", {
    methods: [
      {
        ownerFqn: "net.minecraft.server.MinecraftServer",
        name: "tick",
        javaSignature: "void tick()",
        jvmDescriptor: "()V",
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ],
    fields: [
      {
        ownerFqn: "net.minecraft.server.MinecraftServer",
        name: "running",
        javaSignature: "boolean running",
        jvmDescriptor: "Z",
        accessFlags: 0x0002,
        isSynthetic: false
      }
    ]
  });
  const result = validateParsedAccessWidener(parsed, members, []);
  assert.equal(result.valid, true, `expected valid, got: ${JSON.stringify(result.entries)}`);
  assert.equal(
    result.entries.every((e) => e.valid),
    true
  );
});
