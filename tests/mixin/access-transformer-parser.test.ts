import assert from "node:assert/strict";
import test from "node:test";

import { parseAccessTransformer } from "../../src/access-transformer-parser.ts";

test("parseAccessTransformer parses class, field, and method entries with final actions", () => {
  const content = [
    "# comment",
    "public-f net.minecraft.server.MinecraftServer",
    "protected net.minecraft.server.MinecraftServer field_1234",
    "default+f net.minecraft.server.MinecraftServer func_1234_a()V"
  ].join("\n");

  const result = parseAccessTransformer(content);

  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries[0], {
    line: 2,
    targetKind: "class",
    owner: "net.minecraft.server.MinecraftServer",
    target: "net.minecraft.server.MinecraftServer",
    accessAction: "public",
    finalAction: "remove"
  });
  assert.deepEqual(result.entries[1], {
    line: 3,
    targetKind: "field",
    owner: "net.minecraft.server.MinecraftServer",
    target: "net.minecraft.server.MinecraftServer#field_1234",
    name: "field_1234",
    accessAction: "protected"
  });
  assert.deepEqual(result.entries[2], {
    line: 4,
    targetKind: "method",
    owner: "net.minecraft.server.MinecraftServer",
    target: "net.minecraft.server.MinecraftServer#func_1234_a()V",
    name: "func_1234_a",
    descriptor: "()V",
    accessAction: "package-private",
    finalAction: "add"
  });
  assert.deepEqual(result.parseWarnings, []);
});

test("parseAccessTransformer recognizes wildcard member targets", () => {
  const result = parseAccessTransformer([
    "public net.minecraft.server.MinecraftServer *",
    "public net.minecraft.server.MinecraftServer *()"
  ].join("\n"));

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]?.targetKind, "wildcard-all");
  assert.equal(result.entries[0]?.name, "*");
  assert.equal(result.entries[1]?.targetKind, "wildcard-method");
  assert.equal(result.entries[1]?.name, "*");
  assert.deepEqual(result.parseWarnings, []);
});

test("parseAccessTransformer warns on unsupported access declarations", () => {
  const content = [
    "friend net.minecraft.server.MinecraftServer",
    "public"
  ].join("\n");

  const result = parseAccessTransformer(content);

  assert.equal(result.entries.length, 0);
  assert.ok(result.parseWarnings.some((warning) => warning.includes("Unsupported access declaration")));
  assert.ok(result.parseWarnings.some((warning) => warning.includes("Incomplete access transformer entry")));
});

test("parseAccessTransformer preserves final actions for case-insensitive declarations", () => {
  const result = parseAccessTransformer([
    "PUBLIC+F net.minecraft.server.MinecraftServer",
    "Protected-F net.minecraft.server.MinecraftServer field_1234"
  ].join("\n"));

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]?.accessAction, "public");
  assert.equal(result.entries[0]?.finalAction, "add");
  assert.equal(result.entries[1]?.accessAction, "protected");
  assert.equal(result.entries[1]?.finalAction, "remove");
});
