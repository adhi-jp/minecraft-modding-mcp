import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "../../helpers/zip.ts";
import { callTool } from "../../helpers/mcp-tools-harness.ts";

const EXAMPLE_SOURCE = [
  "package net.minecraft;", //             1
  "", //                                   2
  "public class Example {", //             3
  "  void tick() {", //                    4
  "    run(\"wireMarker\");", //           5
  "  }", //                                6
  "}" //                                   7
].join("\n");

const EXPECTED_ENCLOSING = { symbolKind: "method", symbolName: "tick", startLine: 4, endLine: 6 };

type Hit = { filePath?: string; matchedIn?: string; line?: number; enclosingSymbol?: unknown };
type ToolResult = {
  isError?: boolean;
  structuredContent?: { result?: { hits?: Hit[]; search?: { hits?: Hit[] } } };
};

let artifactIdPromise: Promise<string> | undefined;
function exampleArtifactId(): Promise<string> {
  artifactIdPromise ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "search-enclosing-wire-"));
    const jarPath = join(root, "example-sources.jar");
    await createJar(jarPath, { "net/minecraft/Example.java": EXAMPLE_SOURCE });
    const resolved = await callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath }
    }) as { isError?: boolean; structuredContent?: { result?: { artifactId?: string } } };
    assert.notEqual(resolved.isError, true);
    const artifactId = resolved.structuredContent?.result?.artifactId;
    assert.ok(artifactId, "resolve-artifact must return an artifactId");
    return artifactId;
  })();
  return artifactIdPromise;
}

function assertContentHitEnclosed(hits: Hit[] | undefined, label: string): void {
  assert.ok(Array.isArray(hits) && hits.length === 1, `${label}: expected one hit`);
  const [hit] = hits;
  assert.equal(hit!.matchedIn, "content", label);
  assert.equal(hit!.line, 5, label);
  assert.deepEqual(hit!.enclosingSymbol, EXPECTED_ENCLOSING, label);
}

test("search-class-source text hits carry enclosingSymbol at the default detail and at summary detail", async () => {
  const artifactId = await exampleArtifactId();
  for (const detail of [undefined, "summary"] as const) {
    const result = await callTool("search-class-source", {
      artifactId,
      query: "wireMarker",
      intent: "text",
      ...(detail ? { detail } : {})
    }) as ToolResult;
    assert.notEqual(result.isError, true);
    assertContentHitEnclosed(result.structuredContent?.result?.hits, `detail=${detail ?? "default"}`);
  }
});

test("inspect-minecraft search returns enclosingSymbol on content hits at standard detail and in summary samples", async () => {
  const artifactId = await exampleArtifactId();
  const subject = {
    kind: "search",
    query: "wireMarker",
    intent: "text",
    artifact: { type: "resolved-id", artifactId }
  };

  const standard = await callTool("inspect-minecraft", {
    task: "search",
    detail: "standard",
    subject
  }) as ToolResult;
  assert.notEqual(standard.isError, true);
  assertContentHitEnclosed(standard.structuredContent?.result?.search?.hits, "standard");

  const summary = await callTool("inspect-minecraft", {
    task: "search",
    detail: "summary",
    include: ["samples"],
    subject
  }) as ToolResult;
  assert.notEqual(summary.isError, true);
  assertContentHitEnclosed(summary.structuredContent?.result?.search?.hits, "summary samples");
});
