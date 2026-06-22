import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import test from "node:test";

import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

const CLASS_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

function buildJavaLines(count: number, prefix = "line"): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`${prefix}${i}`);
  }
  return lines.join("\n");
}

async function setupGetClassSource(opts: {
  rootPrefix: string;
  classInternal: string; // e.g. "a/Snippet"
  className: string; // e.g. "a.Snippet"
  sources: Record<string, string>;
}): Promise<{
  root: string;
  artifactId: string;
  service: InstanceType<(typeof import("../src/source-service.ts"))["SourceService"]>;
  className: string;
}> {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), opts.rootPrefix));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");

  await createJar(binaryJarPath, {
    [`${opts.classInternal}.class`]: CLASS_MAGIC
  });
  await createJar(sourcesJarPath, opts.sources);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });
  return { root, artifactId: resolved.artifactId, service, className: opts.className };
}

// --- buildClassSourceSnippet (pure-function tests) ---------------------------

test("buildClassSourceSnippet returns metadata regardless of range args when mode='metadata'", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const content = [
    "package a;",
    "",
    "public class Snippet {",
    "  int x = 1;",
    "  int y = 2;",
    "}"
  ].join("\n");

  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "metadata",
    startLine: 10,
    endLine: 20,
    maxLines: 5,
    maxChars: undefined
  });

  assert.match(result.sourceText, /\[class\] line/);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 6);
  assert.equal(result.totalLines, 6);
  assert.equal(result.truncated, false);
  assert.equal(result.charsTruncated, false);
});

test("buildClassSourceSnippet returns full content for mode='full'", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const content = buildJavaLines(300);
  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "full",
    startLine: undefined,
    endLine: undefined,
    maxLines: undefined,
    maxChars: undefined
  });

  assert.equal(result.sourceText.split("\n").length, 300);
  assert.equal(result.totalLines, 300);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 300);
  assert.equal(result.truncated, false);
});

test("buildClassSourceSnippet returns an empty out-of-range window when startLine is past EOF", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const content = buildJavaLines(5);
  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "snippet",
    startLine: 100,
    endLine: 200,
    maxLines: undefined,
    maxChars: undefined
  });

  // Beyond EOF must not silently clamp into the last real line; return an empty window.
  assert.equal(result.sourceText, "");
  assert.equal(result.returnedStart, 100);
  assert.equal(result.returnedEnd, 99);
  assert.equal(result.truncated, true);
  assert.equal(result.outOfRange, true);
});

test("buildClassSourceSnippet does not count a trailing newline as an extra line", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content: "a\nb\nc\n",
    mode: "full",
    startLine: undefined,
    endLine: undefined,
    maxLines: undefined,
    maxChars: undefined
  });

  assert.equal(result.totalLines, 3);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 3);
  assert.equal(result.sourceText, "a\nb\nc");
});

test("buildClassSourceSnippet reads the last real line of a file ending in a newline", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content: "a\nb\nc\n",
    mode: "snippet",
    startLine: 3,
    endLine: undefined,
    maxLines: undefined,
    maxChars: undefined
  });

  assert.equal(result.returnedStart, 3);
  assert.equal(result.returnedEnd, 3);
  assert.equal(result.sourceText, "c");
  assert.equal(result.outOfRange ?? false, false);
});

test("buildClassSourceSnippet applies maxLines and reports truncated=true", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const content = buildJavaLines(300);
  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "snippet",
    startLine: undefined,
    endLine: undefined,
    maxLines: 200,
    maxChars: undefined
  });

  assert.equal(result.sourceText.split("\n").length, 200);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.charsTruncated, false);
});

test("buildClassSourceSnippet applies maxChars after maxLines and flags charsTruncated", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  // 1000 lines of 80 chars → 81*1000 = 81000 chars before maxChars
  const content = Array.from({ length: 1000 }, () => "x".repeat(80)).join("\n");
  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "snippet",
    startLine: undefined,
    endLine: undefined,
    maxLines: 10,
    maxChars: 200
  });

  assert.equal(result.sourceText.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.charsTruncated, true);
  // The 200-char cut lands mid line 3, so returnedEnd must reflect the last
  // (partial) line actually returned, not the pre-cut 10-line window.
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 3);
  assert.equal(result.nextStartLine, 3);
});

test("buildClassSourceSnippet maxChars only (no maxLines) still truncates and flags both", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const content = "x".repeat(100);
  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content,
    mode: "full",
    startLine: undefined,
    endLine: undefined,
    maxLines: undefined,
    maxChars: 10
  });

  assert.equal(result.sourceText.length, 10);
  assert.equal(result.charsTruncated, true);
  assert.equal(result.truncated, true);
});

test("buildClassSourceSnippet handles empty content without crashing", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content: "",
    mode: "snippet",
    startLine: undefined,
    endLine: undefined,
    maxLines: undefined,
    maxChars: undefined
  });

  assert.equal(result.totalLines, 1);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 1);
  assert.equal(result.sourceText, "");
});

test("buildClassSourceSnippet treats CRLF newlines as line breaks", async () => {
  const { buildClassSourceSnippet } = await import(
    "../src/source/class-source/snippet-builder.ts"
  );

  const result = buildClassSourceSnippet({
    filePath: "a/Snippet.java",
    content: "a\r\nb\r\nc",
    mode: "full",
    startLine: undefined,
    endLine: undefined,
    maxLines: undefined,
    maxChars: undefined
  });

  assert.equal(result.totalLines, 3);
  assert.equal(result.returnedStart, 1);
  assert.equal(result.returnedEnd, 3);
});

// --- getClassSource (integration tests via SourceService) ---------------------

test("getClassSource defaults to mode='metadata' when mode is omitted", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-meta-default-",
    classInternal: "a/Snippet",
    className: "a.Snippet",
    sources: {
      "a/Snippet.java": [
        "package a;",
        "",
        "public class Snippet {",
        "  int x = 1;",
        "  void doIt() {",
        "  }",
        "}"
      ].join("\n")
    }
  });

  const result = await service.getClassSource({ artifactId, className });
  assert.equal(result.mode, "metadata");
  // metadata format includes "// [<kind>] line N" comment headers
  // followed by the declaration line for each symbol
  assert.match(result.sourceText, /\[class\] line 3\s*\n.*public class Snippet/);
  assert.match(result.sourceText, /\[field\] line 4\s*\n\s*int x = 1;/);
  assert.match(result.sourceText, /\[method\] line 5\s*\n\s*void doIt\(\) \{/);
});

test("getClassSource snippet mode applies default maxLines=200 when no range or maxLines given", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-default-200-",
    classInternal: "a/Big",
    className: "a.Big",
    sources: {
      "a/Big.java": ["package a;", "public class Big {", ...Array.from({ length: 297 }, (_, i) => `  int v${i} = ${i};`), "}"].join("\n")
    }
  });

  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "snippet"
  });

  assert.equal(result.mode, "snippet");
  assert.equal(result.returnedRange.start, 1);
  assert.equal(result.returnedRange.end, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.totalLines, 300);
  // The continuation must carry the effective default maxLines so replaying it
  // re-applies the 200-line cap instead of reading the remaining lines at once.
  const suggested = result.suggestedCall as { params?: Record<string, unknown> } | undefined;
  assert.equal(suggested?.params?.startLine, 201);
  assert.equal(suggested?.params?.maxLines, 200);
});

test("getClassSource snippet mode default 200 is disabled when startLine alone is provided", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-default-200-startonly-",
    classInternal: "a/Big",
    className: "a.Big",
    sources: {
      "a/Big.java": ["package a;", "public class Big {", ...Array.from({ length: 497 }, (_, i) => `  int v${i} = ${i};`), "}"].join("\n")
    }
  });

  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "snippet",
    startLine: 10
  });

  // totalLines = 500; with startLine=10 only, maxLines default 200 must NOT apply
  assert.equal(result.totalLines, 500);
  assert.equal(result.returnedRange.start, 10);
  assert.equal(result.returnedRange.end, 500);
  assert.equal(result.truncated, false);
});

test("getClassSource full mode returns all lines with truncated=false", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-full-",
    classInternal: "a/Tiny",
    className: "a.Tiny",
    sources: {
      "a/Tiny.java": ["package a;", "public class Tiny {", "  int x = 1;", "}"].join("\n")
    }
  });

  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "full"
  });

  assert.equal(result.mode, "full");
  assert.equal(result.truncated, false);
  assert.equal(result.totalLines, 4);
  assert.match(result.sourceText, /int x = 1/);
});

test("getClassSource maxChars hard-truncates and exposes charsTruncated=true", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-maxchars-",
    classInternal: "a/Long",
    className: "a.Long",
    sources: {
      "a/Long.java": ["package a;", "public class Long {", "  String s = \"" + "x".repeat(500) + "\";", "}"].join("\n")
    }
  });

  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "full",
    maxChars: 50
  });

  assert.equal(result.sourceText.length, 50);
  assert.equal(result.charsTruncated, true);
  assert.equal(result.truncated, true);
});

test("getClassSource omits charsTruncated key when maxChars is not hit", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-maxchars-loose-",
    classInternal: "a/Tiny",
    className: "a.Tiny",
    sources: {
      "a/Tiny.java": "package a;\npublic class Tiny { int x = 1; }\n"
    }
  });

  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "full",
    maxChars: 100000
  });

  assert.ok(!("charsTruncated" in result), "charsTruncated should be omitted when maxChars is not hit");
});

test("getClassSource outputFile (absolute) writes sourceText and returns placeholder", async () => {
  const { root, artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-outputfile-abs-",
    classInternal: "a/Out",
    className: "a.Out",
    sources: {
      "a/Out.java": "package a;\npublic class Out { int x = 1; }\n"
    }
  });

  const outputPath = join(root, "out.java");
  const result = await service.getClassSource({
    artifactId,
    className,
    mode: "full",
    outputFile: outputPath
  });

  assert.equal(result.outputFile, outputPath);
  assert.match(result.sourceText, /^\[Written to .+\]$/);

  const written = await readFile(outputPath, "utf8");
  assert.match(written, /class Out/);
});

test("getClassSource outputFile (relative) is resolved to absolute path before write", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-outputfile-rel-",
    classInternal: "a/Out",
    className: "a.Out",
    sources: {
      "a/Out.java": "package a;\npublic class Out { int x = 1; }\n"
    }
  });

  // Resolve the relative path from the test's mkdtemp dir, not from
  // process.cwd(). That way the test never writes outside its sandbox and
  // failure on cleanup cannot leak files into the repository checkout.
  const relRoot = await mkdtemp(join(tmpdir(), "snippet-outputfile-rel-cwd-"));
  const relName = `snippet-rel-${process.pid}.java`;
  const previousCwd = process.cwd();
  process.chdir(relRoot);
  try {
    const result = await service.getClassSource({
      artifactId,
      className,
      mode: "full",
      outputFile: relName
    });
    const expected = resolvePath(relRoot, relName);
    assert.equal(typeof result.outputFile, "string");
    assert.equal(isAbsolute(result.outputFile!), true);
    assert.equal(result.outputFile, expected);
    // The relative-path contract is only meaningful if the file was actually
    // written to the resolved absolute path — verify the content reaches disk.
    const written = await readFile(expected, "utf8");
    assert.match(written, /class Out/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("getClassSource rejects startLine=0 with INVALID_INPUT", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-invalid-start-",
    classInternal: "a/Bad",
    className: "a.Bad",
    sources: { "a/Bad.java": "package a;\npublic class Bad {}\n" }
  });

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId,
        className,
        mode: "full",
        startLine: 0
      }),
    (err: any) => {
      assert.equal(err.code, "ERR_INVALID_INPUT");
      assert.equal(err.details?.field, "startLine");
      return true;
    }
  );
});

test("getClassSource rejects startLine>endLine with INVALID_LINE_RANGE", async () => {
  const { artifactId, service, className } = await setupGetClassSource({
    rootPrefix: "snippet-invalid-range-",
    classInternal: "a/Bad",
    className: "a.Bad",
    sources: { "a/Bad.java": "package a;\npublic class Bad {}\n" }
  });

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId,
        className,
        mode: "full",
        startLine: 50,
        endLine: 10
      }),
    (err: any) => {
      assert.equal(err.code, "ERR_INVALID_LINE_RANGE");
      assert.equal(err.details?.startLine, 50);
      assert.equal(err.details?.endLine, 10);
      return true;
    }
  );
});

// --- getArtifactFile maxBytes boundary tests ---------------------------------

test("getArtifactFile applies maxBytes truncation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "snippet-main-"));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");

  await createJar(binaryJarPath, {
    "a/Snippet.class": CLASS_MAGIC
  });
  await createJar(sourcesJarPath, {
    "a/Snippet.java": "line1\nline2\nline3"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "a/Snippet.java",
    maxBytes: 8
  });

  assert.equal(file.filePath, "a/Snippet.java");
  assert.equal(file.truncated, true);
  assert.equal(file.contentBytes, Buffer.byteLength("line1\nline2\nline3", "utf8"));
  assert.equal(Buffer.byteLength(file.content, "utf8"), 8);
});

test("getArtifactFile maxBytes === contentBytes returns full content without truncation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "snippet-maxbytes-eq-"));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");

  const sourceText = "line1\nline2\nline3";
  const exactLen = Buffer.byteLength(sourceText, "utf8");
  await createJar(binaryJarPath, { "a/Snippet.class": CLASS_MAGIC });
  await createJar(sourcesJarPath, { "a/Snippet.java": sourceText });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "a/Snippet.java",
    maxBytes: exactLen
  });

  assert.equal(file.truncated, false);
  assert.equal(file.content, sourceText);
  assert.equal(file.contentBytes, exactLen);
});

test("getArtifactFile maxBytes greater than contentBytes returns full content untruncated", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "snippet-maxbytes-over-"));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");

  const sourceText = "abc\nxyz";
  await createJar(binaryJarPath, { "a/Snippet.class": CLASS_MAGIC });
  await createJar(sourcesJarPath, { "a/Snippet.java": sourceText });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "a/Snippet.java",
    maxBytes: 999
  });

  assert.equal(file.truncated, false);
  assert.equal(file.content, sourceText);
});
