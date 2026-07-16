import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildInnerJarBytes, createShellJar } from "../helpers/nested-jar.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

const API_SOURCE = [
  "package com.example.inner;",
  "public class Api {",
  "  public static final String MARKER = \"nested-jar-marker\";",
  "}"
].join("\n");

async function buildMixedInnerJar(): Promise<Buffer> {
  return buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({
      internalName: "com/example/inner/Api",
      // 0x0019 = public static final
      fields: [{ name: "MARKER", descriptor: "Ljava/lang/String;", accessFlags: 0x0019 }]
    }),
    "com/example/inner/Api.java": API_SOURCE
  });
}

test("getClassSource redirects into the nested jar that contains the class", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-source-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const result = await service.getClassSource({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });

  assert.match(result.sourceText, /nested-jar-marker/);
  assert.equal(result.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");
  assert.ok(result.warnings.some((warning) => warning.includes("META-INF/jars/api.jar")));

  // The redirected artifact identity is deterministic across repeated calls.
  const again = await service.getClassSource({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });
  assert.equal(again.artifactId, result.artifactId);
});

test("getClassMembers answers from the nested jar with redirect provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-members-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const result = await service.getClassMembers({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  assert.ok(result.members.fields.some((field) => field.name === "MARKER"));
  assert.equal(result.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");
});

test("findClassIncludingNested resolves simple and qualified names from a shell jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-find-class-names-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  const simple = await service.findClassIncludingNested({
    className: "Api",
    artifactId: resolved.artifactId
  });
  const qualified = await service.findClassIncludingNested({
    className: "com.example.inner.Api",
    artifactId: resolved.artifactId
  });

  const expected = {
    qualifiedName: "com.example.inner.Api",
    filePath: "com/example/inner/Api.java",
    line: 1,
    symbolKind: "class"
  };
  assert.deepEqual(simple.matches, [expected]);
  assert.deepEqual(qualified.matches, [expected]);
});

test("findClassIncludingNested normalizes inner classes to their outer source path", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-find-class-inner-"));
  const inner = await buildInnerJarBytes({
    "com/example/Outer.class": buildClassFile({ internalName: "com/example/Outer" }),
    "com/example/Outer$Inner.class": buildClassFile({ internalName: "com/example/Outer$Inner" }),
    "com/example/Outer$1.class": buildClassFile({ internalName: "com/example/Outer$1" }),
    "module-info.class": buildClassFile({ internalName: "module-info" }),
    "com/example/package-info.class": buildClassFile({ internalName: "com/example/package-info" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  const simple = await service.findClassIncludingNested({
    className: "Inner",
    artifactId: resolved.artifactId
  });
  const qualified = await service.findClassIncludingNested({
    className: "com.example.Outer.Inner",
    artifactId: resolved.artifactId
  });

  assert.deepEqual(simple.matches, [{
    qualifiedName: "com.example.Outer.Inner",
    filePath: "com/example/Outer.java",
    line: 1,
    symbolKind: "class"
  }]);
  assert.deepEqual(qualified.matches, simple.matches);
});

test("a dotted inner-class match remains readable through the shell source redirect", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-inner-source-redirect-"));
  const inner = await buildInnerJarBytes({
    "com/example/Outer.class": buildClassFile({ internalName: "com/example/Outer" }),
    "com/example/Outer$Inner.class": buildClassFile({ internalName: "com/example/Outer$Inner" }),
    "com/example/Outer.java": [
      "package com.example;",
      "public class Outer {",
      "  public static class Inner {}",
      "}"
    ].join("\n")
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const result = await service.getClassSource({
    className: "com.example.Outer.Inner",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });

  assert.match(result.sourceText, /static class Inner/);
  assert.equal(result.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");
});

test("findClassIncludingNested deduplicates names deterministically and honors limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-find-class-limit-"));
  const alpha = await buildInnerJarBytes({
    "alpha/Shared.class": buildClassFile({ internalName: "alpha/Shared" })
  });
  const beta = await buildInnerJarBytes({
    "alpha/Shared.class": buildClassFile({ internalName: "alpha/Shared" }),
    "beta/Shared.class": buildClassFile({ internalName: "beta/Shared" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, {
    "META-INF/jars/z-beta.jar": beta,
    "META-INF/jars/a-alpha.jar": alpha
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  const all = await service.findClassIncludingNested({
    className: "Shared",
    artifactId: resolved.artifactId,
    limit: 20
  });
  const limited = await service.findClassIncludingNested({
    className: "Shared",
    artifactId: resolved.artifactId,
    limit: 1
  });

  assert.deepEqual(all.matches.map((match) => match.qualifiedName), ["alpha.Shared", "beta.Shared"]);
  assert.equal(all.total, 2);
  assert.deepEqual(limited.matches.map((match) => match.qualifiedName), ["alpha.Shared"]);
  assert.equal(limited.total, 1);
});

test("findClassIncludingNested omits vanilla obfuscation advice for a shell miss", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-find-class-miss-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });
  const result = await service.findClassIncludingNested({
    className: "MissingApi",
    artifactId: resolved.artifactId
  });

  assert.equal(result.total, 0);
  assert.ok(result.warnings.every((warning) => !warning.includes("obfuscated runtime names")));
});

test("a class present in two nested jars returns candidates instead of a silent pick", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-collision-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, {
    "META-INF/jars/api-a.jar": inner,
    "META-INF/jars/api-b.jar": inner
  });

  const service = new SourceService(buildTestConfig(root));
  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.example.inner.Api",
        target: { kind: "jar", value: shellPath },
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { code?: string; details?: { nestedJarCandidates?: string[] } }) => {
      assert.equal(error.code, "ERR_NESTED_JAR_AMBIGUOUS");
      assert.deepEqual(error.details?.nestedJarCandidates, [
        "META-INF/jars/api-a.jar",
        "META-INF/jars/api-b.jar"
      ]);
      return true;
    }
  );
});

test("getClassMembers raises nested-jar candidates for a class present in two nested jars", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-members-collision-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, {
    "META-INF/jars/api-a.jar": inner,
    "META-INF/jars/api-b.jar": inner
  });

  const service = new SourceService(buildTestConfig(root));
  await assert.rejects(
    () =>
      service.getClassMembers({
        className: "com.example.inner.Api",
        target: { kind: "jar", value: shellPath },
        mapping: "obfuscated"
      }),
    (error: Error & { code?: string; details?: { nestedJarCandidates?: string[] } }) => {
      assert.equal(error.code, "ERR_NESTED_JAR_AMBIGUOUS");
      assert.deepEqual(error.details?.nestedJarCandidates, [
        "META-INF/jars/api-a.jar",
        "META-INF/jars/api-b.jar"
      ]);
      return true;
    }
  );
});

test("a class in no nested jar keeps the class-not-found contract and names the inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-miss-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.example.absent.Missing",
        target: { kind: "jar", value: shellPath },
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { code?: string; details?: { nestedJars?: string[] } }) => {
      assert.equal(error.code, "ERR_CLASS_NOT_FOUND");
      assert.deepEqual(error.details?.nestedJars, ["META-INF/jars/api.jar"]);
      return true;
    }
  );
});

test("the same class resolves via the submodule coordinate and the shell redirect with distinct deterministic identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-crossing-"));
  const { mkdir } = await import("node:fs/promises");
  const { createJar } = await import("../helpers/zip.ts");

  // Path A: the submodule's own coordinate, backed by a local m2 layout —
  // the authoritative route when a dependency target names the submodule.
  const m2Dir = join(
    root,
    "m2",
    "net/fabricmc/fabric-api/fabric-screen-handler-api-v1/2.0.5"
  );
  await mkdir(m2Dir, { recursive: true });
  await createJar(join(m2Dir, "fabric-screen-handler-api-v1-2.0.5-sources.jar"), {
    "com/example/inner/Api.java": API_SOURCE
  });
  await createJar(join(m2Dir, "fabric-screen-handler-api-v1-2.0.5.jar"), {
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });

  // Path B: the umbrella shell jar bundling the same class in a nested jar.
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));

  const viaCoordinate = await service.resolveArtifact({
    target: { kind: "coordinate", value: "net.fabricmc.fabric-api:fabric-screen-handler-api-v1:2.0.5" },
    mapping: "obfuscated"
  });
  const viaCoordinateAgain = await service.resolveArtifact({
    target: { kind: "coordinate", value: "net.fabricmc.fabric-api:fabric-screen-handler-api-v1:2.0.5" },
    mapping: "obfuscated"
  });
  const viaRedirect = await service.getClassSource({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });
  const viaRedirectAgain = await service.getClassSource({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });

  // Deterministic identities per path, distinct identities across paths.
  assert.equal(viaCoordinateAgain.artifactId, viaCoordinate.artifactId);
  assert.equal(viaRedirectAgain.artifactId, viaRedirect.artifactId);
  assert.notEqual(viaRedirect.artifactId, viaCoordinate.artifactId);

  // Provenance distinguishes the two routes.
  assert.equal(viaCoordinate.provenance.nestedJar, undefined);
  assert.equal(viaRedirect.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");

  // Both routes serve the class content.
  const coordinateSource = await service.getClassSource({
    className: "com.example.inner.Api",
    artifactId: viaCoordinate.artifactId,
    mapping: "obfuscated",
    mode: "full"
  });
  assert.match(coordinateSource.sourceText, /nested-jar-marker/);
  assert.match(viaRedirect.sourceText, /nested-jar-marker/);
});

test("an archive containing a traversal-named entry is rejected outright", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-adversarial-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  // tests/helpers/zip.ts writes entry names verbatim, so the archive really
  // contains an entry whose name tries to escape the extraction directory.
  // The zip reader rejects the whole archive fail-closed before any nested-jar
  // handling (or extraction) can run.
  await createShellJar(
    shellPath,
    { "META-INF/jars/api.jar": inner },
    { extraEntries: { "../escape.jar": inner } }
  );

  const service = new SourceService(buildTestConfig(root));
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: shellPath },
        mapping: "obfuscated"
      }),
    (error: Error & { code?: string; details?: { reason?: string } }) => {
      assert.equal(error.code, "ERR_ARTIFACT_RESOLUTION_FAILED");
      assert.match(String(error.details?.reason ?? ""), /invalid relative path/);
      return true;
    }
  );
});

test("declared-but-escaping nested jar paths are excluded from the shell inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nested-redirect-declared-escape-"));
  const inner = await buildMixedInnerJar();
  const shellPath = join(root, "shell.jar");
  // The fabric.mod.json declares escaping and absent paths; the archive itself
  // only contains safe entry names, so it resolves — with the unsafe
  // declarations dropped from the inventory.
  const { createJar } = await import("../helpers/zip.ts");
  await createJar(shellPath, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "declared-escape",
      version: "1.0.0",
      jars: [
        { file: "../outside.jar" },
        { file: "/abs/evil.jar" },
        { file: "META-INF/jars/api.jar" }
      ]
    }),
    "META-INF/jars/api.jar": inner
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  assert.deepEqual(resolved.provenance.nestedJars, ["META-INF/jars/api.jar"]);
});
