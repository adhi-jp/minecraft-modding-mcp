import assert from "node:assert/strict";
import test from "node:test";

import { parseMixinSource } from "../../src/mixin-parser.ts";
import { validateParsedMixin } from "../../src/mixin-validator.ts";
import { makeTargetMembers } from "../helpers/mixin-validator-fixtures.ts";

test("parseMixinSource strips the default shadow$ prefix from the @Shadow target name", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  public abstract void shadow$tick();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName })),
    [{ name: "shadow$tick", targetName: "tick" }]
  );
});

test("parseMixinSource honours an explicit @Shadow prefix attribute", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(prefix = "handler$") public abstract void handler$onTick();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName })),
    [{ name: "handler$onTick", targetName: "onTick" }]
  );
});

test("parseMixinSource treats an explicit empty @Shadow prefix as no prefix at all", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(prefix = "") public abstract void shadow$tick();
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName })),
    [{ name: "shadow$tick", targetName: "shadow$tick" }]
  );
});

test("parseMixinSource does not strip the shadow prefix from a @Shadow field", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow private int shadow$health;
  @Shadow(prefix = "f_") private int f_armor;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ kind: entry.kind, name: entry.name, targetName: entry.targetName })),
    [
      { kind: "field", name: "shadow$health", targetName: "shadow$health" },
      { kind: "field", name: "f_armor", targetName: "f_armor" }
    ]
  );
});

test("parseMixinSource leaves an unprefixed @Shadow member name unchanged", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow private int health;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, targetName: entry.targetName })),
    [{ name: "health", targetName: "health" }]
  );
});

test("parseMixinSource collects @Shadow aliases", () => {
  const source = `
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(aliases = {"f_20945_", "field_6224"})
  private int health;
}
`;
  const result = parseMixinSource(source);

  assert.deepEqual(
    result.shadows.map((entry) => ({ name: entry.name, aliases: entry.aliases })),
    [{ name: "health", aliases: ["f_20945_", "field_6224"] }]
  );
});

test("validateParsedMixin resolves a prefixed @Shadow method against the unprefixed target", () => {
  const parsed = parseMixinSource(`
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  public abstract void shadow$tick();
}
`);
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, []);

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.resolvedMembers?.map((member) => ({
      name: member.name,
      resolvedTo: member.resolvedTo,
      status: member.status
    })),
    [{ name: "shadow$tick", resolvedTo: "PlayerEntity#tick", status: "resolved" }]
  );
});

test("validateParsedMixin resolves a @Shadow field through one of its aliases", () => {
  const parsed = parseMixinSource(`
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow(aliases = {"f_20945_"})
  private int health;
}
`);
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["f_20945_"] })]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, []);

  assert.deepEqual(result.issues, []);
  assert.equal(result.resolvedMembers?.[0]?.resolvedTo, "PlayerEntity#f_20945_");
});

test("validateParsedMixin still reports a genuinely missing prefixed @Shadow member", () => {
  const parsed = parseMixinSource(`
@Mixin(PlayerEntity.class)
public abstract class PlayerMixin {
  @Shadow
  public abstract void shadow$tick();
}
`);
  const targetMembers = new Map([
    ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["attack"] })]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, []);

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "method-not-found");
  assert.match(result.issues[0].message, /shadow\$tick/);
});
