/**
 * Compile-mapping detection reads build scripts as text, so a commented-out
 * alternative used to count as evidence: a Yarn project that still carried
 * `// mappings loom.officialMojangMappings()` looked like it declared two
 * mappings, and `detectCompileMapping` answered unresolved. Comments must be
 * ignored, while text inside string literals (`"https://..."`) must not be
 * mistaken for a comment opener.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("detectCompileMapping ignores a mapping declaration inside a line comment", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-line-comment-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  // mappings loom.officialMojangMappings()",
      "  mappings \"net.fabricmc:yarn:1.21.10+build.1:v2\"",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
  assert.deepEqual(result.evidence.map((entry) => entry.mapping), ["yarn"]);
});

test("detectCompileMapping ignores a mapping declaration inside a block comment", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-block-comment-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    [
      "/*",
      " * Earlier revision used the Mojang route:",
      " *   mappings(loom.officialMojangMappings())",
      " */",
      "dependencies {",
      "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
  assert.deepEqual(result.evidence.map((entry) => entry.mapping), ["yarn"]);
});

test("detectCompileMapping does not treat comment openers inside string literals as comments", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-string-literal-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      // The `//` of the repository URL sits on the same line as the declaration, and
      // the unterminated `/*` lives in a string: neither may hide what follows it.
      "def note = 'the /* below is data, not a comment'",
      "repositories { maven { url = \"https://maven.fabricmc.net/\" } }; " +
        "dependencies { mappings \"net.fabricmc:yarn:1.21.10+build.1:v2\" }"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
});

test("detectCompileMapping still reports a conflict when both declarations are live", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-live-conflict-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      "// mappings \"net.fabricmc:intermediary:1.21.10\"",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n"),
    "utf8"
  );
  await mkdir(join(root, "common"), { recursive: true });
  await writeFile(
    join(root, "common", "build.gradle.kts"),
    ["dependencies {", "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")", "}"].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, false);
  assert.equal(result.mappingApplied, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("Multiple compile mappings")));
  assert.deepEqual(
    [...new Set(result.evidence.map((entry) => entry.mapping))].sort(),
    ["mojang", "yarn"],
    "the commented-out intermediary line must not appear as evidence"
  );
});

test("detectCompileMapping honors nested block comments in a Kotlin build script", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-nested-comment-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    [
      // Kotlin block comments nest, so the inner `*/` closes only the inner comment and
      // the mappings call stays commented out to the end of the line.
      "/* outer /* note */ mappings(loom.officialMojangMappings()) */",
      "dependencies {",
      "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
  assert.deepEqual(result.evidence.map((entry) => entry.mapping), ["yarn"]);
});

test("detectCompileMapping reads a Groovy dollar-slashy string as a literal", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-dollar-slashy-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      // `$/ ... /$` holds a URL whose `//` must not open a comment and swallow the
      // declaration that shares the line.
      "def repo = $/https://example.test/$; " +
        "dependencies { mappings \"net.fabricmc:yarn:1.21.10+build.1:v2\" }"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
});

test("detectCompileMapping terminates a Kotlin raw string that ends in a backslash", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-raw-string-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    [
      // A Kotlin raw string has no escape sequences, so the trailing backslash is data
      // and the very next `\"\"\"` closes the literal.
      "val modsDir = \"\"\"C:\\mods\\\"\"\"",
      "// mappings(loom.officialMojangMappings())",
      "dependencies {",
      "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true, `expected a resolved yarn project, got ${JSON.stringify(result)}`);
  assert.equal(result.mappingApplied, "yarn");
  assert.deepEqual(result.evidence.map((entry) => entry.mapping), ["yarn"]);
});
