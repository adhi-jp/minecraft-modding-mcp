import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPackTarballName, findPackedTarball } from "./helpers/package-smoke.ts";

test("buildPackTarballName normalizes scoped package names the same way npm pack does", () => {
  assert.equal(
    buildPackTarballName("@adhisang/minecraft-modding-mcp", "2.0.0"),
    "adhisang-minecraft-modding-mcp-2.0.0.tgz"
  );
  assert.equal(buildPackTarballName("plain-package", "1.2.3"), "plain-package-1.2.3.tgz");
});

test("findPackedTarball resolves the tarball from pack destination without npm json output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "package-smoke-helper-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });

  const packDir = join(root, "pack");
  await mkdir(packDir, { recursive: true });
  const tarballName = "adhisang-minecraft-modding-mcp-2.0.0.tgz";
  const tarballPath = join(packDir, tarballName);
  await writeFile(tarballPath, "placeholder");

  const resolved = await findPackedTarball(packDir, {
    name: "@adhisang/minecraft-modding-mcp",
    version: "2.0.0"
  });

  assert.equal(resolved, tarballPath);
});

test("findPackedTarball throws a descriptive error when no tarball was produced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "package-smoke-helper-empty-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });

  await assert.rejects(
    () =>
      findPackedTarball(root, {
        name: "@adhisang/minecraft-modding-mcp",
        version: "2.0.0"
      }),
    /did not produce a tarball/
  );
});
