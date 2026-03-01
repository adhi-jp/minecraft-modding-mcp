import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  normalizedCoordinateValue,
  parseCoordinate
} from "../src/maven-resolver.ts";

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
