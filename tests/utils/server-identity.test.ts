import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  SERVER_IDENTITY,
  SERVER_NAME,
  SERVER_VERSION,
  getServerVersionFromPackageJson,
  serverIdentitySnapshot
} from "../../src/server-identity.ts";

/**
 * Canonical server-identity module — the single source of the {name, version}
 * Implementation shared by the worker bootstrap (index.ts McpServer
 * construction) and the supervisor's synthetic decorator.
 */

const PACKAGE_JSON = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8")
) as { name: string; version: string };

test("SERVER_IDENTITY matches the package.json name and version", () => {
  assert.equal(SERVER_NAME, "@adhisang/minecraft-modding-mcp");
  assert.equal(SERVER_IDENTITY.name, PACKAGE_JSON.name);
  assert.equal(SERVER_IDENTITY.version, PACKAGE_JSON.version);
  assert.equal(SERVER_VERSION, PACKAGE_JSON.version);
});

test("getServerVersionFromPackageJson reads a non-empty trimmed version", () => {
  const version = getServerVersionFromPackageJson();
  assert.equal(version, version.trim());
  assert.notEqual(version.length, 0);
  assert.equal(version, SERVER_VERSION);
});

test("SERVER_IDENTITY is frozen and snapshots are independent copies", () => {
  assert.equal(Object.isFrozen(SERVER_IDENTITY), true, "the canonical identity must be frozen");
  const snapshot = serverIdentitySnapshot();
  assert.deepEqual(snapshot, { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version });
  assert.notEqual(snapshot, SERVER_IDENTITY, "snapshot must be a fresh object, not the frozen constant");
  snapshot.name = "mutated";
  assert.equal(SERVER_IDENTITY.name, SERVER_NAME, "mutating a snapshot must not affect the canonical identity");
  assert.notEqual(serverIdentitySnapshot().name, "mutated", "snapshots must not share state");
});
