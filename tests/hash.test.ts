import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeFileSha1 } from "../src/hash.ts";

test("computeFileSha1 returns correct hash for known content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hash-test-"));
  const filePath = join(dir, "sample.bin");
  const content = "hello world";
  await writeFile(filePath, content);

  const expected = createHash("sha1").update(content).digest("hex");
  const actual = await computeFileSha1(filePath);
  assert.equal(actual, expected);
});

test("computeFileSha1 returns correct hash for empty file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hash-test-empty-"));
  const filePath = join(dir, "empty.bin");
  await writeFile(filePath, "");

  const expected = createHash("sha1").update("").digest("hex");
  const actual = await computeFileSha1(filePath);
  assert.equal(actual, expected);
});

test("computeFileSha1 rejects for non-existent file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hash-test-missing-"));
  const missingPath = join(dir, "does-not-exist.bin");
  await assert.rejects(
    () => computeFileSha1(missingPath),
    { code: "ENOENT" }
  );
});
