import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  normalizedCoordinateValue,
  parseCoordinate
} from "../../src/maven-resolver.ts";

test("parseCoordinate supports 3 and 4 segment forms", () => {
  const plain = parseCoordinate("net.fabricmc:fabric-loader:1.2.3");
  assert.equal(plain.groupId, "net.fabricmc");
  assert.equal(plain.classifier, undefined);

  const withClassifier = parseCoordinate("com.example:demo:1.0.0:client");
  assert.equal(withClassifier.artifactId, "demo");
  assert.equal(withClassifier.classifier, "client");
  assert.equal(normalizedCoordinateValue(" com.example:demo:1.0.0:client "), "com.example:demo:1.0.0:client");
});

test("parseCoordinate rejects invalid coordinates with structured code", () => {
  assert.throws(
    () => parseCoordinate("bad-coordinate"),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.COORDINATE_PARSE_FAILED
      );
    }
  );
});

test("buildRemoteSourceUrls emits classifier and fallback source names", () => {
  const repos = ["https://repo1.maven.org/maven2"];
  const urls = buildRemoteSourceUrls(repos, "com.example:demo:1.0.0:client");
  assert.deepEqual(urls, [
    "https://repo1.maven.org/maven2/com/example/demo/1.0.0/demo-1.0.0-client-sources.jar",
    "https://repo1.maven.org/maven2/com/example/demo/1.0.0/demo-1.0.0-sources.jar"
  ]);
});

test("buildRemoteBinaryUrls emits deterministic binary URL order", () => {
  const repos = ["https://repo1.maven.org/maven2", "https://maven.fabricmc.net"];
  const urls = buildRemoteBinaryUrls(repos, "com.example:demo:1.0.0");
  assert.deepEqual(urls, [
    "https://repo1.maven.org/maven2/com/example/demo/1.0.0/demo-1.0.0.jar",
    "https://maven.fabricmc.net/com/example/demo/1.0.0/demo-1.0.0.jar"
  ]);
});

import {
  enumerateLocalAlternativeSourceJars,
  hasExistingJar,
  localArtifactPathsFromCoordinate,
  resolveLocalM2Candidate,
  resolveLocalSourceJar
} from "../../src/maven-resolver.ts";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseCoordinate rejects 5+ segment coordinates", () => {
  assert.throws(
    () => parseCoordinate("g:a:type:v:c"),
    (err: any) => err.code === ERROR_CODES.COORDINATE_PARSE_FAILED && err.details?.coordinate === "g:a:type:v:c"
  );
});

test("parseCoordinate rejects coordinates with any empty mandatory segment", () => {
  for (const value of [":a:1.0", "g::1.0", "g:a:", ":::"]) {
    assert.throws(
      () => parseCoordinate(value),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
        // Each failing input must be echoed back in `details.coordinate` so
        // agent callers can identify which coordinate failed. A regression
        // that dropped the echo would still satisfy a plain code check.
        assert.equal(err.details?.coordinate, value);
        return true;
      },
      `expected reject for "${value}"`
    );
  }
});

test("parseCoordinate normalises empty / whitespace classifier to undefined", () => {
  assert.equal(parseCoordinate("g:a:1.0:").classifier, undefined);
  assert.equal(parseCoordinate("g:a:1.0:   ").classifier, undefined);
});

test("parseCoordinate accepts SNAPSHOT and timestamped versions verbatim", () => {
  const snap = parseCoordinate("net.foo:bar:1.0.0-SNAPSHOT");
  assert.equal(snap.version, "1.0.0-SNAPSHOT");
  const build = parseCoordinate("net.foo:bar:21.0+build.5");
  assert.equal(build.version, "21.0+build.5");
});

test("parseCoordinate trims surrounding whitespace and echoes original input in error details", () => {
  const trimmed = parseCoordinate("  net.foo:bar:1.0.0  ");
  assert.equal(trimmed.groupId, "net.foo");
  assert.throws(
    () => parseCoordinate(" :a:v "),
    (err: any) => err.code === ERROR_CODES.COORDINATE_PARSE_FAILED && err.details?.coordinate === " :a:v "
  );
});

test("buildRemoteSourceUrls emits a single URL when no classifier (no duplicate fallback)", () => {
  const urls = buildRemoteSourceUrls(["https://repo1.maven.org/maven2"], "com.example:demo:1.0.0");
  assert.deepEqual(urls, [
    "https://repo1.maven.org/maven2/com/example/demo/1.0.0/demo-1.0.0-sources.jar"
  ]);
});

test("buildRemoteSourceUrls and buildRemoteBinaryUrls both return [] for empty repo list", () => {
  assert.deepEqual(buildRemoteSourceUrls([], "com.example:demo:1.0.0:client"), []);
  assert.deepEqual(buildRemoteBinaryUrls([], "com.example:demo:1.0.0"), []);
});

test("buildRemoteBinaryUrls strips a single trailing slash from repo base URL", () => {
  const noSlash = buildRemoteBinaryUrls(["https://repo.example.com/maven2"], "com.example:demo:1.0.0");
  const slash = buildRemoteBinaryUrls(["https://repo.example.com/maven2/"], "com.example:demo:1.0.0");
  assert.deepEqual(noSlash, slash);
});

test("buildRemoteBinaryUrls includes classifier suffix in binary jar name", () => {
  const urls = buildRemoteBinaryUrls(["https://repo.example.com/maven2"], "com.example:demo:1.0.0:client");
  assert.deepEqual(urls, [
    "https://repo.example.com/maven2/com/example/demo/1.0.0/demo-1.0.0-client.jar"
  ]);
});

test("resolveLocalM2Candidate builds correct source and binary jar paths without classifier", () => {
  const candidate = resolveLocalM2Candidate("/m2", "net.fabricmc:fabric-loader:0.16.0");
  assert.equal(
    candidate.sourceJarPath,
    join("/m2", "net", "fabricmc", "fabric-loader", "0.16.0", "fabric-loader-0.16.0-sources.jar")
  );
  assert.equal(
    candidate.binaryJarPath,
    join("/m2", "net", "fabricmc", "fabric-loader", "0.16.0", "fabric-loader-0.16.0.jar")
  );
});

test("resolveLocalM2Candidate inserts classifier in both source and binary jar names", () => {
  const candidate = resolveLocalM2Candidate("/m2", "com.example:demo:1.0:client");
  assert.equal(
    candidate.sourceJarPath,
    join("/m2", "com", "example", "demo", "1.0", "demo-1.0-client-sources.jar")
  );
  assert.equal(
    candidate.binaryJarPath,
    join("/m2", "com", "example", "demo", "1.0", "demo-1.0-client.jar")
  );
});

test("localArtifactPathsFromCoordinate matches resolveLocalM2Candidate output", () => {
  assert.deepEqual(
    localArtifactPathsFromCoordinate("/m2", "com.example:demo:1.0"),
    resolveLocalM2Candidate("/m2", "com.example:demo:1.0")
  );
});

test("groupToPath collapses empty segments in groupId (a..b → a/b)", () => {
  const urls = buildRemoteBinaryUrls(["https://repo.example.com/maven2"], "a..b:c:1.0");
  assert.deepEqual(urls, ["https://repo.example.com/maven2/a/b/c/1.0/c-1.0.jar"]);
});

test("hasExistingJar returns true only for existing regular files", async () => {
  const root = mkdtempSync(join(tmpdir(), "has-jar-"));
  const filePath = join(root, "x.jar");
  const dirPath = join(root, "asdir.jar");
  await writeFile(filePath, "");
  await mkdir(dirPath);
  assert.equal(hasExistingJar(undefined), false);
  assert.equal(hasExistingJar(join(root, "nonexistent.jar")), false);
  assert.equal(hasExistingJar(dirPath), false);
  assert.equal(hasExistingJar(filePath), true);
});

test("resolveLocalSourceJar prefers source jar when present and returns undefined otherwise", async () => {
  const m2 = mkdtempSync(join(tmpdir(), "resolve-src-"));
  const versionDir = join(m2, "com", "example", "demo", "1.0");
  await mkdir(versionDir, { recursive: true });
  const sourcePath = join(versionDir, "demo-1.0-sources.jar");
  const binaryPath = join(versionDir, "demo-1.0.jar");

  // (1) nothing present → undefined
  assert.equal(resolveLocalSourceJar(m2, "com.example:demo:1.0"), undefined);

  // (2) binary only → still undefined (no guess from binary)
  await writeFile(binaryPath, "");
  assert.equal(resolveLocalSourceJar(m2, "com.example:demo:1.0"), undefined);

  // (3) sources present → returns the source path
  await writeFile(sourcePath, "");
  assert.equal(resolveLocalSourceJar(m2, "com.example:demo:1.0"), sourcePath);
});

test("enumerateLocalAlternativeSourceJars returns [] for missing directory and filters with prefix + .jar suffix", async () => {
  const m2 = mkdtempSync(join(tmpdir(), "enum-src-"));
  assert.deepEqual(
    enumerateLocalAlternativeSourceJars(m2, "com.example:demo:1.0"),
    [],
    "missing version directory must return []"
  );

  const versionDir = join(m2, "com", "example", "demo", "1.0");
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, "demo-1.0-sources.jar"), "");
  await writeFile(join(versionDir, "demo-1.0-extra-sources.jar"), "");
  await writeFile(join(versionDir, "other-1.0-sources.jar"), "");
  await writeFile(join(versionDir, "demo-1.0.jar"), "");

  const found = enumerateLocalAlternativeSourceJars(m2, "com.example:demo:1.0").sort();
  assert.deepEqual(found, [
    join(versionDir, "demo-1.0-extra-sources.jar"),
    join(versionDir, "demo-1.0-sources.jar")
  ]);
});
