import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { normalizeJarPath } from "../src/path-resolver.ts";

test("normalizeJarPath rejects malformed windows-drive path format", () => {
  assert.throws(
    () => normalizeJarPath("C:bad\\minecraft.jar"),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );
});

import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  artifactSignatureFromFile,
  buildJarSignature,
  isSecureJarEntryPath,
  resolveJarPathWithSymlinkCheck,
  validateAndNormalizeJarPath
} from "../src/path-resolver.ts";

// --- normalizeJarPath happy paths and structured errors --------------------

test("normalizeJarPath returns the realpath of an existing .jar file", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-ok-"));
  const jarPath = join(root, "mod.jar");
  await writeFile(jarPath, Buffer.from("PK\x03\x04"));
  const resolved = normalizeJarPath(jarPath);
  const expected = await realpath(jarPath);
  assert.equal(resolved, expected);
});

test("normalizeJarPath accepts a .JAR (uppercase) extension via case-insensitive comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-jar-upper-"));
  const jarPath = join(root, "MOD.JAR");
  await writeFile(jarPath, "");
  const resolved = normalizeJarPath(jarPath);
  assert.equal(resolved, await realpath(jarPath));
});

test("normalizeJarPath rejects missing paths with JAR_NOT_FOUND", () => {
  assert.throws(
    () => normalizeJarPath("/tmp/path-resolver-nonexistent-xyz.jar"),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.JAR_NOT_FOUND);
      assert.ok(err.details?.jarPath);
      return true;
    }
  );
});

test("normalizeJarPath rejects directory paths with JAR_NOT_FOUND (Expected a file path)", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-dir-"));
  assert.throws(
    () => normalizeJarPath(root),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.JAR_NOT_FOUND);
      assert.match(err.message ?? "", /Expected a file path/);
      return true;
    }
  );
});

test("normalizeJarPath rejects non-.jar extensions with INVALID_INPUT (Expected a .jar file)", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-ext-"));
  const txt = join(root, "notjar.txt");
  await writeFile(txt, "");
  assert.throws(
    () => normalizeJarPath(txt),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
      assert.match(err.message ?? "", /Expected a \.jar file/);
      assert.equal(err.details?.jarPath, txt);
      return true;
    }
  );
});

test("normalizeJarPath does NOT reject a -sources.jar at this layer (delegated to caller)", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-sources-jar-"));
  const sourcesJar = join(root, "mod-sources.jar");
  await writeFile(sourcesJar, "");
  const resolved = normalizeJarPath(sourcesJar);
  assert.equal(resolved, await realpath(sourcesJar));
});

test("normalizeJarPath resolves a symlink to the target's realpath", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-symlink-"));
  const realJar = join(root, "real.jar");
  const linkJar = join(root, "link.jar");
  await writeFile(realJar, "");
  await symlink(realJar, linkJar);
  const resolved = normalizeJarPath(linkJar);
  assert.equal(resolved, await realpath(realJar));
});

// --- resolveJarPathWithSymlinkCheck -----------------------------------------

test("resolveJarPathWithSymlinkCheck preserves the original input alongside the resolved path", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-rsws-"));
  const realJar = join(root, "real.jar");
  const linkJar = join(root, "link.jar");
  await writeFile(realJar, "");
  await symlink(realJar, linkJar);
  const info = resolveJarPathWithSymlinkCheck(linkJar);
  assert.equal(info.originalPath, linkJar);
  assert.equal(info.resolvedPath, await realpath(realJar));
});

// --- artifactSignatureFromFile / buildJarSignature ---------------------------

test("buildJarSignature emits `<truncated mtime>:<size>` format", () => {
  assert.equal(buildJarSignature({ mtimeMs: 1700000000.123, size: 42 }), "1700000000:42");
});

test("artifactSignatureFromFile yields a stable sha256 id for the same jar contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-sig-"));
  const jar = join(root, "mod.jar");
  await writeFile(jar, Buffer.from("PK\x03\x04"));
  const sig1 = artifactSignatureFromFile(jar);
  const sig2 = artifactSignatureFromFile(jar);
  assert.match(sig1.sourceArtifactId, /^[a-f0-9]{64}$/);
  assert.equal(sig1.sourceArtifactId, sig2.sourceArtifactId);
  assert.equal(sig1.signature, sig2.signature);
  assert.equal(typeof sig1.signatureParts.mtimeMs, "number");
  assert.equal(typeof sig1.signatureParts.size, "number");
});

// --- isSecureJarEntryPath: zip slip defense ----------------------------------

test("isSecureJarEntryPath accepts safe relative entry paths", () => {
  assert.equal(isSecureJarEntryPath("a/b/c.class"), true);
  assert.equal(isSecureJarEntryPath("META-INF/MANIFEST.MF"), true);
  // A `..` substring inside a filename is fine (not surrounded by separators).
  assert.equal(isSecureJarEntryPath("a/..b/c"), true);
});

test("isSecureJarEntryPath rejects path traversal segments (POSIX and Windows separators)", () => {
  for (const value of [
    "../etc/passwd",
    "a/../etc",
    "..\\etc",
    "a\\..\\etc",
    "META-INF/../etc/passwd",
    "..",
    "../"
  ]) {
    assert.equal(isSecureJarEntryPath(value), false, `expected zip-slip rejection for ${JSON.stringify(value)}`);
  }
});

// --- validateAndNormalizeJarPath ---------------------------------------------

test("validateAndNormalizeJarPath rejects empty / whitespace input with INVALID_INPUT", () => {
  for (const value of ["", "   ", "\t\n"]) {
    assert.throws(
      () => validateAndNormalizeJarPath(value),
      (err: any) => err.code === ERROR_CODES.INVALID_INPUT,
      `expected INVALID_INPUT for ${JSON.stringify(value)}`
    );
  }
});

test("validateAndNormalizeJarPath rewraps internal errors as INVALID_INPUT with the input path in details", () => {
  // Missing file would normally throw JAR_NOT_FOUND from normalizeJarPath.
  // validateAndNormalizeJarPath must re-wrap that as INVALID_INPUT.
  assert.throws(
    () => validateAndNormalizeJarPath("/tmp/path-resolver-validate-missing.jar"),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(err.details?.jarPath, "/tmp/path-resolver-validate-missing.jar");
      return true;
    }
  );
});

test("validateAndNormalizeJarPath returns the realpath of an existing .jar (success forwarding)", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-resolver-validate-ok-"));
  const jar = join(root, "mod.jar");
  await writeFile(jar, "");
  const resolved = validateAndNormalizeJarPath(`  ${jar}  `);
  assert.equal(resolved, await realpath(jar));
});
