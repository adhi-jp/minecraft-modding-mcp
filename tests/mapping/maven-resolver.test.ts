import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import {
  buildRemoteBinaryUrls,
  buildRemoteSourceUrls,
  isMutableMavenCoordinate,
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

test("parseCoordinate rejects a..b as a groupId, and groupToPath still collapses empty segments", () => {
  // `a..b` is CONTAINED under the collapsing builder, so this rejection is not a
  // containment fix. It exists so the coordinate route answers exactly as the
  // already-stricter dependency route does, and a doubled dot is not a
  // publishable groupId anyway: it names an empty Maven path segment.
  assert.throws(
    () => buildRemoteBinaryUrls(["https://repo.example.com/maven2"], "a..b:c:1.0"),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
      assert.equal(err.details?.component, "groupId");
      return true;
    }
  );

  // The collapsing itself is the load-bearing half and still happens - it is
  // what stops a groupId from ever contributing an empty, and therefore
  // root-anchored, path segment. A trailing dot passes the token rule, and
  // `"a.b.".split(".")` still ends in an empty segment for `filter(Boolean)` to
  // drop.
  const urls = buildRemoteBinaryUrls(["https://repo.example.com/maven2"], "a.b.:c:1.0");
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

test("isMutableMavenCoordinate flags -SNAPSHOT versions and leaves release and timestamped versions immutable", () => {
  // Maven defines only the -SNAPSHOT suffix as mutable. The suffix match here is
  // deliberately case-insensitive where Maven's own is not: mistaking a mutable
  // artifact for an immutable one caches it forever, while the reverse costs a
  // single conditional request.
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-SNAPSHOT"), true);
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-snapshot"), true);
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-SnapShot"), true);
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-SNAPSHOT:client"), true);

  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0"), false);
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0:client"), false);
  // A resolved unique snapshot is a concrete, immutable artifact.
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-20240101.120000-3"), false);
  // A version that merely mentions snapshot without the suffix is not mutable.
  assert.equal(isMutableMavenCoordinate("com.example:demo:1.0.0-SNAPSHOT-final"), false);
});

// --- coordinate segment validation ------------------------------------------
//
// Every segment of a coordinate becomes a directory or file-name component
// downstream: the ~/.m2 layout, the Gradle cache layout, and the remote
// repository URL. `parseCoordinate` is the single chokepoint all nine consumers
// go through, so the rule is proved here rather than nine times over.

/** Builds a coordinate whose named component carries `value`. */
const COORDINATE_SLOTS: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ["groupId", (value) => `${value}:art:1.0`],
  ["artifactId", (value) => `g:${value}:1.0`],
  ["version", (value) => `g:art:${value}`],
  ["classifier", (value) => `g:art:1.0:${value}`]
];

test("parseCoordinate rejects path separators, NUL and control characters in every component", () => {
  // A space is NOT on this list - see the space tests below. It is not a path
  // separator, cannot leave a directory, and appears in published Yarn
  // versions, so `version` and `classifier` admit it; `groupId` and
  // `artifactId` still refuse it, which is covered separately.
  const hostile = ["../etc", "a/b", "a\\b", "a\0b", "a\nb", "a\tb", "a;b", "$(id)"];
  for (const [component, build] of COORDINATE_SLOTS) {
    for (const value of hostile) {
      const coordinate = build(value);
      assert.throws(
        () => parseCoordinate(coordinate),
        (err: any) => {
          assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
          assert.equal(
            err.details?.component,
            component,
            `error must name the offending component for ${JSON.stringify(coordinate)}`
          );
          assert.equal(err.details?.coordinate, coordinate);
          return true;
        },
        `expected reject for ${component}=${JSON.stringify(value)}`
      );
    }
  }
});

test("parseCoordinate keeps the space out of groupId and artifactId", () => {
  // Maven identifiers never contain a space and no published coordinate uses
  // one here, so the identifier half of the rule stays exactly as strict as it
  // was. Widening it would buy no artifact.
  for (const [component, build] of COORDINATE_SLOTS.filter(
    ([name]) => name === "groupId" || name === "artifactId"
  )) {
    for (const value of ["a b", "net.example foo", "lib v2"]) {
      assert.throws(
        () => parseCoordinate(build(value)),
        (err: any) => {
          assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
          assert.equal(err.details?.component, component);
          return true;
        },
        `expected reject for ${component}=${JSON.stringify(value)}`
      );
    }
  }
});

test("parseCoordinate accepts a space in version and classifier, Yarn's pre-release build included", () => {
  // Minecraft's own 1.14 pre-release ids contain spaces, and Fabric published
  // Yarn against them verbatim. This is a real, published coordinate: refusing
  // it is a false rejection of an artifact that exists, which is the worse of
  // the two failure directions. Containment is untouched - a space is not a
  // path separator and cannot traverse a directory, so the segment still
  // becomes exactly one path component.
  const yarn = parseCoordinate("net.fabricmc:yarn:1.14 Pre-Release 1+build.10:v2");
  assert.deepEqual(yarn, {
    groupId: "net.fabricmc",
    artifactId: "yarn",
    version: "1.14 Pre-Release 1+build.10",
    classifier: "v2"
  });

  // The spaces INSIDE the segment survive; only the padding around it is trimmed.
  assert.equal(
    parseCoordinate("net.fabricmc:yarn:  1.14 Pre-Release 1+build.10  :v2").version,
    "1.14 Pre-Release 1+build.10"
  );
  assert.equal(parseCoordinate("g:a:1.0:linux x64").classifier, "linux x64");

  // A segment that is nothing but spaces is still empty after the trim.
  assert.throws(
    () => parseCoordinate("g:a:   "),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
      assert.equal(err.details?.component, "version");
      return true;
    }
  );
});

test("parseCoordinate names the empty component when a mandatory segment is blank", () => {
  // Every other rejection carries `details.component`. This branch used to drop
  // it, so a caller branching on the field had to special-case exactly one
  // error shape out of the set.
  const blank: ReadonlyArray<readonly [string, string]> = [
    [":art:1.0", "groupId"],
    ["   :art:1.0", "groupId"],
    ["g::1.0", "artifactId"],
    ["g:   :1.0", "artifactId"],
    ["g:art:", "version"],
    ["g:art:   ", "version"]
  ];
  for (const [coordinate, component] of blank) {
    assert.throws(
      () => parseCoordinate(coordinate),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
        assert.equal(err.details?.component, component, `for ${JSON.stringify(coordinate)}`);
        assert.equal(err.details?.coordinate, coordinate);
        return true;
      },
      `expected reject for ${JSON.stringify(coordinate)}`
    );
  }
});

test("parseCoordinate rejects a component made only of dots", () => {
  for (const [component, build] of COORDINATE_SLOTS) {
    for (const value of [".", "..", "...", "...."]) {
      assert.throws(
        () => parseCoordinate(build(value)),
        (err: any) => {
          assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
          assert.equal(err.details?.component, component);
          return true;
        },
        `expected reject for ${component}=${JSON.stringify(value)}`
      );
    }
  }
});

test("parseCoordinate rejects a groupId with a leading dot even without a slash or ..", () => {
  // The escape a character rule alone would miss. `.a` carries no separator and
  // no `..`, but `".a".replace(/\./g, "/")` is `/a` - an ABSOLUTE path that
  // `path.resolve` honours by discarding the repository root in front of it.
  // The group leg is safe by construction now (see the containment test over
  // `localM2CoordinateCandidatePaths`); this keeps the input from getting that
  // far in the first place.
  for (const value of [".a", ".hidden", ".m2"]) {
    assert.throws(
      () => parseCoordinate(`${value}:art:1.0`),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
        assert.equal(err.details?.component, "groupId");
        assert.match(String(err.message), /\[A-Za-z0-9\._\+-\]/);
        return true;
      },
      `expected reject for groupId=${JSON.stringify(value)}`
    );
  }
});

test("parseCoordinate trims each segment and still echoes the untrimmed coordinate on rejection", () => {
  // Padding around a segment is the caller's formatting, not their intent, so
  // it is trimmed rather than rejected by the character rule.
  const spaced = parseCoordinate("g : a : 1.0 : client");
  assert.equal(spaced.groupId, "g");
  assert.equal(spaced.artifactId, "a");
  assert.equal(spaced.version, "1.0");
  assert.equal(spaced.classifier, "client");

  // The echo is the caller's own text: it is what they have to find and fix.
  const untrimmed = " net.foo:bar:1.0/../etc ";
  assert.throws(
    () => parseCoordinate(untrimmed),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.COORDINATE_PARSE_FAILED);
      assert.equal(err.details?.coordinate, untrimmed);
      assert.equal(err.details?.component, "version");
      return true;
    }
  );
});

test("parseCoordinate accepts the published coordinate shapes the rule must not break", () => {
  const accepted: ReadonlyArray<readonly [string, string, string, string, string | undefined]> = [
    [
      "net.fabricmc.fabric-api:fabric-gametest-api-v1:4.0.21+4a7fa0819e",
      "net.fabricmc.fabric-api",
      "fabric-gametest-api-v1",
      "4.0.21+4a7fa0819e",
      undefined
    ],
    ["net.fabricmc:yarn:1.21.10+build.1:v2", "net.fabricmc", "yarn", "1.21.10+build.1", "v2"],
    // Fabric published Yarn against Minecraft's 1.14 pre-release ids verbatim,
    // spaces and all.
    [
      "net.fabricmc:yarn:1.14 Pre-Release 1+build.10:v2",
      "net.fabricmc",
      "yarn",
      "1.14 Pre-Release 1+build.10",
      "v2"
    ],
    ["net.fabricmc:fabric-loader:0.16.10:client", "net.fabricmc", "fabric-loader", "0.16.10", "client"],
    ["net.minecraft:client:26.1", "net.minecraft", "client", "26.1", undefined],
    ["net.minecraft:launchwrapper:1.12", "net.minecraft", "launchwrapper", "1.12", undefined],
    ["dev.architectury:architectury:18.0.6", "dev.architectury", "architectury", "18.0.6", undefined],
    [
      "com.example:demo:1.0.0-20240101.120000-3",
      "com.example",
      "demo",
      "1.0.0-20240101.120000-3",
      undefined
    ],
    ["com.example:demo:1.0.0-SNAPSHOT:client", "com.example", "demo", "1.0.0-SNAPSHOT", "client"],
    ["com.example:classified:1.0:linux", "com.example", "classified", "1.0", "linux"],
    ["g:a:1", "g", "a", "1", undefined],
    ["net.neoforged:neoforge:0.153.0+26.2", "net.neoforged", "neoforge", "0.153.0+26.2", undefined],
    [
      "net.minecraftforge:forge:1.20.1-47.2.0:userdev",
      "net.minecraftforge",
      "forge",
      "1.20.1-47.2.0",
      "userdev"
    ],
    ["net.minecraft:server:1.17-SNAPSHOT", "net.minecraft", "server", "1.17-SNAPSHOT", undefined],
    // Padding around the whole string was accepted before the rule landed and
    // still is.
    ["  net.foo:bar:1.0.0  ", "net.foo", "bar", "1.0.0", undefined]
  ];

  for (const [coordinate, groupId, artifactId, version, classifier] of accepted) {
    const parsed = parseCoordinate(coordinate);
    assert.deepEqual(
      parsed,
      { groupId, artifactId, version, classifier },
      `must still parse ${JSON.stringify(coordinate)}`
    );
  }

  // An empty or whitespace-only classifier is absent, not a segment to validate.
  assert.equal(parseCoordinate("g:a:1.0:").classifier, undefined);
  assert.equal(parseCoordinate("g:a:1.0:   ").classifier, undefined);
});
