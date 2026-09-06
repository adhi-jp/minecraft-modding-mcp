import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  composeArtifactId,
  contentDigestSignature,
  contentSignature,
  DECOMPILE_SIGNATURE_QUALIFIER,
  jarArtifactIdentity
} from "../../src/artifact-identity.ts";
import { createJar } from "../helpers/zip.ts";

const sha256Of = (recipe: string): string => createHash("sha256").update(recipe).digest("hex");

/** The sha256 of a file's bytes: the signature both id spaces are built on. */
async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/**
 * Block until the filesystem stamps a change time later than `afterMs`.
 *
 * Linux takes ctime from a coarse clock, so two writes inside one tick read
 * back the same `ctimeMs`. The memo's ctime check can only be exercised once
 * the tick has moved on, and rewriting a throwaway file is how we find out: it
 * shares the clock without touching anything the test is measuring.
 */
async function waitForChangeClockPast(directory: string, afterMs: number): Promise<void> {
  const sentinel = join(directory, "change-clock-sentinel");
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    await writeFile(sentinel, String(attempt));
    if (statSync(sentinel).ctimeMs > afterMs) {
      return;
    }
    await delay(1);
  }
  throw new Error("the filesystem change-time clock never advanced");
}

test("composeArtifactId lays the jar id space out as jar, path, signature, source", () => {
  const digest = "b".repeat(64);
  const signature = contentDigestSignature(digest);

  assert.equal(
    composeArtifactId({ space: "jar", jarPath: "/store/demo.jar", signature }),
    sha256Of(`jar|/store/demo.jar|${digest}|source`)
  );
  assert.equal(
    composeArtifactId({
      space: "jar",
      jarPath: "/store/demo.jar",
      signature,
      signatureQualifier: DECOMPILE_SIGNATURE_QUALIFIER
    }),
    sha256Of(`jar|/store/demo.jar|${digest}:decompile|source`),
    "the qualifier joins the signature, not the parts list"
  );
  assert.equal(
    composeArtifactId({
      space: "jar",
      jarPath: "/store/demo.jar",
      signature,
      mappingVariant: "mojang-remapped"
    }),
    sha256Of(`jar|/store/demo.jar|${digest}|source|mojang-remapped`),
    "the variant is appended last"
  );
  assert.equal(
    composeArtifactId({ space: "jar", jarPath: "/store/demo.jar", signature, mappingVariant: "pass" }),
    composeArtifactId({ space: "jar", jarPath: "/store/demo.jar", signature }),
    "\"pass\" is the default and adds nothing"
  );
});

test("composeArtifactId lays the coordinate id space out as coord, coordinate, idSource, signature", () => {
  const signature = contentDigestSignature("a".repeat(64));

  assert.equal(
    composeArtifactId({
      space: "coordinate",
      coordinate: "com.example:demo:1.2.3",
      idSource: "local-m2",
      signature
    }),
    sha256Of(`coord|com.example:demo:1.2.3|local-m2|${"a".repeat(64)}`)
  );
  assert.notEqual(
    composeArtifactId({
      space: "coordinate",
      coordinate: "com.example:demo:1.2.3",
      idSource: "local-m2",
      signature
    }),
    composeArtifactId({
      space: "coordinate",
      coordinate: "com.example:demo:1.2.3",
      idSource: "remote-repo",
      signature
    }),
    "the id space keeps artifacts found along different routes apart"
  );
  assert.equal(
    composeArtifactId({
      space: "coordinate",
      coordinate: "com.example:demo:1.2.3",
      idSource: "local-m2",
      signature,
      mappingVariant: "mojang-remapped"
    }),
    sha256Of(`coord|com.example:demo:1.2.3|local-m2|${"a".repeat(64)}|mojang-remapped`)
  );
});

test("jarArtifactIdentity resolves the path before it derives and composes", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "artifact-identity-normalize-")));
  const realStore = join(root, "real");
  await mkdir(realStore, { recursive: true });
  const realJarPath = join(realStore, "demo.jar");
  await createJar(realJarPath, { "com/example/Demo.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]) });
  await symlink(realStore, join(root, "linked"), "dir");

  const viaLink = await jarArtifactIdentity(join(root, "linked", "demo.jar"));
  const viaRealPath = await jarArtifactIdentity(realJarPath);

  assert.equal(viaLink.resolvedPath, realJarPath);
  assert.equal(viaLink.artifactId, viaRealPath.artifactId);
  assert.equal(
    viaLink.artifactId,
    sha256Of(`jar|${realJarPath}|${await sha256OfFile(realJarPath)}|source`),
    "the id is composed from the resolved path and a sha256 of that file's bytes"
  );
});

test("jarArtifactIdentity carries the decompile qualifier into both the published signature and the id", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "artifact-identity-qualifier-")));
  const jarPath = join(root, "runtime.jar");
  await createJar(jarPath, { "net/minecraft/Marker.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]) });

  const plain = await jarArtifactIdentity(jarPath);
  const decompiled = await jarArtifactIdentity(jarPath, {
    signatureQualifier: DECOMPILE_SIGNATURE_QUALIFIER
  });

  const jarDigest = await sha256OfFile(jarPath);
  assert.equal(plain.signature, jarDigest);
  assert.equal(decompiled.signature, `${jarDigest}:decompile`);
  assert.notEqual(
    decompiled.artifactId,
    plain.artifactId,
    "a jar read for sources and the same jar handed to the decompiler are different artifacts"
  );
});

test("contentSignature answers from the bytes on disk, not from a stat that stayed put", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "artifact-identity-memo-")));
  const jarPath = join(root, "memoized.jar");
  await createJar(jarPath, {
    "com/example/Memoized.java": ["package com.example;", "public class Memoized {}"].join("\n")
  });

  // Whole-millisecond mtimes throughout, so the value restored below is exactly
  // the one the memo recorded rather than a rounded neighbour of it.
  const firstMtime = new Date(1_700_000_000_000);
  await utimes(jarPath, firstMtime, firstMtime);

  const first = await contentSignature(jarPath);
  assert.equal(first.from, "content-digest");
  assert.equal(first.value, await sha256OfFile(jarPath));

  // A `touch` and nothing else. The id is about the bytes, so the answer must
  // not move even though mtime did.
  const secondMtime = new Date(1_700_000_060_000);
  await utimes(jarPath, secondMtime, secondMtime);
  const afterTouch = await contentSignature(jarPath);
  assert.equal(afterTouch.value, first.value, "a touch alone must not change the digest");

  // That call re-derived and re-recorded, so the memo now holds this file's
  // size, mtime, inode and change time.
  const recorded = statSync(jarPath);
  await waitForChangeClockPast(root, recorded.ctimeMs);

  // Replace the bytes keeping the length, then put the recorded mtime back.
  // Size, mtime and inode all still match what the memo holds and only ctimeMs
  // moved, so ctimeMs alone has to reject the entry - otherwise the memo would
  // answer for bytes that are gone, and this memo is now the derivation behind
  // every artifactId rather than a private cache.
  const sameLengthReplacement = Buffer.alloc(recorded.size, 0x5a);
  await writeFile(jarPath, sameLengthReplacement);
  await utimes(jarPath, secondMtime, secondMtime);

  const replaced = statSync(jarPath);
  assert.equal(replaced.size, recorded.size, "the replacement must keep the length");
  assert.equal(replaced.mtimeMs, recorded.mtimeMs, "the replacement must carry the recorded mtime");
  assert.equal(replaced.ino, recorded.ino, "the replacement must reuse the inode");
  assert.notEqual(replaced.ctimeMs, recorded.ctimeMs, "ctimeMs must be the only field that moved");

  const rederived = await contentSignature(jarPath);
  assert.equal(rederived.value, createHash("sha256").update(sameLengthReplacement).digest("hex"));
  assert.notEqual(rederived.value, first.value);
});
