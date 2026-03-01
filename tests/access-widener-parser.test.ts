import assert from "node:assert/strict";
import test from "node:test";

import { parseAccessWidener } from "../src/access-widener-parser.ts";

test("parseAccessWidener parses header correctly", () => {
  const content = `accessWidener v2 intermediary
`;
  const result = parseAccessWidener(content);
  assert.equal(result.headerVersion, "v2");
  assert.equal(result.namespace, "intermediary");
  assert.equal(result.entries.length, 0);
  assert.equal(result.parseWarnings.length, 0);
});

test("parseAccessWidener parses class entry", () => {
  const content = `accessWidener v2 intermediary
accessible class net/minecraft/server/MinecraftServer
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, "accessible");
  assert.equal(result.entries[0].targetKind, "class");
  assert.equal(result.entries[0].target, "net/minecraft/server/MinecraftServer");
  assert.equal(result.entries[0].owner, undefined);
});

test("parseAccessWidener parses method entry", () => {
  const content = `accessWidener v2 intermediary
accessible method net/minecraft/server/MinecraftServer tick ()V
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, "accessible");
  assert.equal(result.entries[0].targetKind, "method");
  assert.equal(result.entries[0].owner, "net/minecraft/server/MinecraftServer");
  assert.equal(result.entries[0].name, "tick");
  assert.equal(result.entries[0].descriptor, "()V");
});

test("parseAccessWidener parses field entry", () => {
  const content = `accessWidener v2 intermediary
mutable field net/minecraft/server/MinecraftServer running Z
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, "mutable");
  assert.equal(result.entries[0].targetKind, "field");
  assert.equal(result.entries[0].name, "running");
  assert.equal(result.entries[0].descriptor, "Z");
});

test("parseAccessWidener skips comments and blank lines", () => {
  const content = `accessWidener v2 intermediary

# This is a comment
accessible class net/minecraft/server/MinecraftServer

# Another comment
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 1);
  assert.equal(result.parseWarnings.length, 0);
});

test("parseAccessWidener warns on invalid access kind", () => {
  const content = `accessWidener v2 intermediary
invalid class net/minecraft/server/MinecraftServer
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes('Unknown access kind "invalid"')));
});

test("parseAccessWidener warns on invalid target kind", () => {
  const content = `accessWidener v2 intermediary
accessible interface net/minecraft/server/MinecraftServer
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes('Unknown target kind "interface"')));
});

test("parseAccessWidener warns on missing header", () => {
  const content = `accessible class net/minecraft/server/MinecraftServer
`;
  const result = parseAccessWidener(content);
  assert.ok(result.parseWarnings.some((w) => w.includes("Expected accessWidener header")));
});

test("parseAccessWidener warns on incomplete method entry", () => {
  const content = `accessWidener v2 intermediary
accessible method net/minecraft/server/MinecraftServer tick
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 0);
  assert.ok(result.parseWarnings.some((w) => w.includes("requires owner, name, and descriptor")));
});

test("parseAccessWidener parses multiple entries", () => {
  const content = `accessWidener v2 intermediary
accessible class net/minecraft/server/MinecraftServer
accessible method net/minecraft/server/MinecraftServer tick ()V
mutable field net/minecraft/server/MinecraftServer running Z
extendable class net/minecraft/world/World
`;
  const result = parseAccessWidener(content);
  assert.equal(result.entries.length, 4);
  assert.equal(result.entries[0].targetKind, "class");
  assert.equal(result.entries[1].targetKind, "method");
  assert.equal(result.entries[2].targetKind, "field");
  assert.equal(result.entries[3].kind, "extendable");
});
