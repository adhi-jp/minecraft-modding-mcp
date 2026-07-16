import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "../../helpers/zip.ts";
import { buildClassFile } from "../../helpers/classfile.ts";
import { callTool, listTools } from "../../helpers/mcp-tools-harness.ts";

test("get-class-members surfaces meta.warningDetails for the truncation family", async () => {
  const root = await mkdtemp(join(tmpdir(), "warning-details-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [
        { name: "alpha", descriptor: "()V", accessFlags: 0x0001 },
        { name: "beta", descriptor: "()V", accessFlags: 0x0001 },
        { name: "gamma", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  const result = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all",
    maxMembers: 1
  }) as {
    structuredContent?: {
      result?: { truncated?: boolean };
      meta?: { warnings?: string[]; warningDetails?: Array<{ code?: string; category?: string; index?: number; message?: string }> };
    };
  };

  assert.equal(result.structuredContent?.result?.truncated, true);
  const details = result.structuredContent?.meta?.warningDetails;
  assert.ok(Array.isArray(details) && details.length >= 1, "expected meta.warningDetails");
  const truncationDetail = details!.find((d) => d.code === "result_truncated" && d.category === "pagination");
  assert.ok(truncationDetail, "truncation warning must classify as result_truncated/pagination");
  // The text lives only in meta.warnings; the detail references it by index.
  const warnings = result.structuredContent?.meta?.warnings;
  assert.ok(Array.isArray(warnings));
  assert.equal(typeof truncationDetail!.index, "number");
  assert.equal(typeof warnings![truncationDetail!.index!], "string");
  assert.equal(truncationDetail!.message, undefined, "warningDetails must not duplicate the text");
});

test("get-class-members drops FIELD jvmDescriptor by default and restores it with includeDescriptors (methods always keep it)", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-descriptor-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      fields: [{ name: "count", descriptor: "I", accessFlags: 0x0001 }],
      methods: [{ name: "run", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  type MembersResult = { structuredContent?: { result?: { members?: { fields?: Array<Record<string, unknown>>; methods?: Array<Record<string, unknown>> } } } };
  const base = { target: { kind: "artifact", artifactId }, className: "com.example.Widget", access: "all" } as const;

  const def = await callTool("get-class-members", base) as MembersResult;
  const defMembers = def.structuredContent?.result?.members ?? {};
  assert.equal(defMembers.fields?.[0]?.jvmDescriptor, undefined, "field descriptor omitted by default");
  assert.equal(defMembers.methods?.[0]?.jvmDescriptor, "()V", "method descriptor always present");

  const opted = await callTool("get-class-members", { ...base, includeDescriptors: true }) as MembersResult;
  const optedMembers = opted.structuredContent?.result?.members ?? {};
  assert.equal(optedMembers.fields?.[0]?.jvmDescriptor, "I", "field descriptor restored with includeDescriptors");
  assert.equal(optedMembers.methods?.[0]?.jvmDescriptor, "()V");

  // The new include:["descriptors"] array form must be an equivalent alias on the expert tool.
  const viaInclude = await callTool("get-class-members", { ...base, include: ["descriptors"] }) as MembersResult;
  const viaIncludeMembers = viaInclude.structuredContent?.result?.members ?? {};
  assert.equal(viaIncludeMembers.fields?.[0]?.jvmDescriptor, "I", "field descriptor restored with include:[\"descriptors\"]");
});

test("get-class-source / get-class-members include:[\"provenance\"] round-trips diagnostics (alias of includeProvenance)", async () => {
  const root = await mkdtemp(join(tmpdir(), "include-provenance-roundtrip-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [{ name: "run", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });
  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  type Res = { structuredContent?: { result?: Record<string, unknown> } };
  const target = { kind: "artifact", artifactId } as const;

  // Default (no include) omits diagnostics; include:["provenance"] restores them — for both tools.
  const memDefault = await callTool("get-class-members", { target, className: "com.example.Widget", access: "all" }) as Res;
  assert.equal("provenance" in (memDefault.structuredContent?.result ?? {}), false, "members provenance omitted by default");
  const memInc = await callTool("get-class-members", { target, className: "com.example.Widget", access: "all", include: ["provenance"] }) as Res;
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in (memInc.structuredContent?.result ?? {}), `members ${key} restored with include:["provenance"]`);
  }
  const srcInc = await callTool("get-class-source", { target, className: "com.example.Widget", mode: "metadata", include: ["provenance"] }) as Res;
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in (srcInc.structuredContent?.result ?? {}), `source ${key} restored with include:["provenance"]`);
  }
});

test("get-class-members omits provenance/qualityFlags/artifactContents by default and restores them with includeProvenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-default-members-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Widget.class": buildClassFile({
      internalName: "com/example/Widget",
      accessFlags: 0x0001,
      methods: [{ name: "alpha", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  const defaultResult = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all"
  }) as { structuredContent?: { result?: Record<string, unknown> } };
  const defaulted = defaultResult.structuredContent?.result ?? {};
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.equal(key in defaulted, false, `${key} must be omitted by default`);
  }
  // The diagnostic-free common path still carries the members + context.
  assert.ok("members" in defaulted);
  assert.ok("context" in defaulted, "context survives the default strip");

  const withProvenance = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Widget",
    access: "all",
    includeProvenance: true
  }) as { structuredContent?: { result?: Record<string, unknown> } };
  const enriched = withProvenance.structuredContent?.result ?? {};
  for (const key of ["provenance", "qualityFlags", "artifactContents"]) {
    assert.ok(key in enriched, `${key} must return with includeProvenance:true`);
  }
});

test("analyze-mod remap preview returns an operation block without mutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "analyze-mod-tool-"));
  const jarPath = join(root, "example.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example",
      version: "1.0.0",
      name: "Example",
      depends: {
        minecraft: "1.21.10"
      }
    }, null, 2)
  });

  const result = await callTool("analyze-mod", {
    task: "remap",
    subject: {
      kind: "jar",
      jarPath
    },
    targetMapping: "mojang",
    executionMode: "preview"
  }) as {
    structuredContent?: {
      result?: {
        summary?: { status?: string };
        operation?: { executionMode?: string; targetMapping?: string };
      };
    };
  };

  assert.equal(result.structuredContent?.result?.summary?.status, "unchanged");
  assert.equal(result.structuredContent?.result?.operation?.executionMode, "preview");
  assert.equal(result.structuredContent?.result?.operation?.targetMapping, "mojang");
});

test("manage-cache summary normalizes apply to preview at the public contract", async () => {
  const result = await callTool("manage-cache", {
    action: "summary",
    cacheKinds: ["downloads"],
    executionMode: "apply",
    include: ["preview", "warnings"]
  }) as {
    structuredContent?: {
      meta?: {
        detailApplied?: string;
        includeApplied?: string[];
      };
      result?: {
        operation?: { executionMode?: string };
      };
    };
  };

  // detailApplied is omitted when it equals the tool default ("summary" for entry tools)
  assert.equal(result.structuredContent?.meta?.detailApplied, undefined);
  assert.deepEqual(result.structuredContent?.meta?.includeApplied, ["warnings", "preview"]);
  assert.equal(result.structuredContent?.result?.operation?.executionMode, "preview");
});

test("expert and batch tools expose detail/include and no longer expose compact", async () => {
  const toolMap = new Map((await listTools()).map((entry) => [entry.name, entry.inputSchema]));
  const detailTools = [
    "resolve-artifact",
    "find-mapping",
    "resolve-method-mapping-exact",
    "resolve-workspace-symbol",
    "check-symbol-exists",
    "get-class-source",
    "get-class-members",
    "search-class-source",
    "list-artifact-files",
    "batch-class-source",
    "batch-class-members",
    "batch-symbol-exists",
    "batch-mappings"
  ];
  for (const name of detailTools) {
    const schema = toolMap.get(name) as { properties?: Record<string, { enum?: string[]; default?: string }> };
    assert.ok(schema?.properties, `${name} must have an input schema`);
    assert.equal("compact" in (schema.properties ?? {}), false, `${name} must not expose compact`);
    const detail = schema.properties?.detail;
    assert.ok(detail, `${name} must expose detail`);
    assert.deepEqual(detail.enum, ["summary", "standard", "full"], `${name} detail enum`);
    assert.ok("include" in (schema.properties ?? {}), `${name} must expose include`);
  }
  // resolution/mapping + batch default summary; source/file default standard.
  const expectDefault: Record<string, string> = {
    "resolve-artifact": "summary",
    "find-mapping": "summary",
    "resolve-method-mapping-exact": "summary",
    "resolve-workspace-symbol": "summary",
    "check-symbol-exists": "summary",
    "batch-class-source": "summary",
    "batch-class-members": "summary",
    "batch-symbol-exists": "summary",
    "batch-mappings": "summary",
    "get-class-source": "standard",
    "get-class-members": "standard",
    "search-class-source": "standard",
    "list-artifact-files": "standard"
  };
  for (const [name, want] of Object.entries(expectDefault)) {
    const schema = toolMap.get(name) as { properties?: { detail?: { default?: string } } };
    assert.equal(schema.properties?.detail?.default, want, `${name} default detail`);
  }
});

test("find-mapping detail=summary does not corrupt identity-branch result and preserves meta.warnings", async () => {
  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const baseArgs = {
    version: "1.21.10",
    kind: "class",
    name: "dhl",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("find-mapping", { ...baseArgs, detail: "summary" }) as Promise<ToolResult>,
    callTool("find-mapping", { ...baseArgs, detail: "full" }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  // Compact must not add or corrupt any key
  for (const [key, value] of Object.entries(compactResult)) {
    assert.ok(key in normalResult, `compact added unexpected key: ${key}`);
    assert.deepEqual(value, normalResult[key], `compact corrupted key: ${key}`);
  }

  // Keys that compact is allowed to drop:
  // - empty/null/undefined values (P1 compactResponse)
  // - "candidates" when provably redundant (P4 compactMappingResponse)
  const ALLOWED_COMPACT_DROPS = new Set(["candidates", "candidatesTruncated"]);
  const droppedKeys: string[] = [];
  for (const key of Object.keys(normalResult)) {
    if (!(key in compactResult)) {
      droppedKeys.push(key);
      if (!ALLOWED_COMPACT_DROPS.has(key)) {
        const v = normalResult[key];
        const isEmpty =
          v === null ||
          v === undefined ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
        assert.ok(isEmpty, `compact dropped non-empty key: ${key} = ${JSON.stringify(v)}`);
      }
    }
  }

  // At least one key must have been dropped to prove compact is active
  assert.ok(droppedKeys.length > 0, `compact must drop at least one key, but none were dropped`);
  // candidates must be dropped (P4: identity branch resolved + exact + count=1)
  assert.ok(droppedKeys.includes("candidates"), "candidates should be dropped for resolved exact identity branch");

  // meta.warnings is omitted when empty; detail must not change what meta carries
  assert.deepEqual(
    withCompact.structuredContent?.meta?.warnings,
    withoutCompact.structuredContent?.meta?.warnings
  );
});

test("resolve-artifact compact:true omits diagnostic fields from local-jar result", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-artifact-"));
  const jarPath = join(root, "test-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n"
  });

  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      detail: "summary"
    }) as Promise<ToolResult>,
    callTool("resolve-artifact", {
      target: { kind: "jar", value: jarPath },
      detail: "full"
    }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  // Diagnostic fields must be omitted in compact mode
  const omitKeys = [
    "provenance", "artifactContents", "sampleEntries",
    "adjacentSourceCandidates", "binaryJarPath", "coordinate",
    "repoUrl", "resolvedSourceJarPath"
  ];
  for (const key of omitKeys) {
    assert.equal(key in compactResult, false, `${key} should be omitted in compact mode`);
  }

  // Essential fields must be preserved
  const keptKeys = ["artifactId", "origin", "isDecompiled", "mappingApplied", "qualityFlags"];
  for (const key of keptKeys) {
    assert.ok(key in compactResult, `${key} should be preserved`);
    assert.deepEqual(compactResult[key], normalResult[key], `${key} value should match`);
  }

  // Normal result must have at least some of the diagnostic fields
  assert.ok("artifactContents" in normalResult, "normal result should have artifactContents");

  // meta.warnings is omitted when empty; detail must not change what meta carries
  assert.deepEqual(
    withCompact.structuredContent?.meta?.warnings,
    withoutCompact.structuredContent?.meta?.warnings
  );
});

test("list-artifact-files compact:true drops artifactContents and preserves items", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-listfiles-"));
  const jarPath = join(root, "example-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n",
    "net/minecraft/Other.java": "package net.minecraft;\npublic class Other {}\n"
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath }
  }) as {
    isError?: boolean;
    structuredContent?: { result?: { artifactId?: string } };
  };
  assert.notEqual(resolveResult.isError, true);
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId);

  type ToolResult = {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
      meta?: { warnings?: string[] };
    };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("list-artifact-files", { artifactId, detail: "summary" }) as Promise<ToolResult>,
    callTool("list-artifact-files", { artifactId, detail: "full" }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  assert.equal("artifactContents" in compactResult, false, "artifactContents should be omitted in compact");
  assert.ok("artifactContents" in normalResult, "normal result should have artifactContents");
  assert.deepEqual(compactResult.items, normalResult.items, "items payload should match");
});

test("search-class-source compact:true preserves hits and drops empty arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-searchsrc-"));
  const jarPath = join(root, "example-sources.jar");
  await createJar(jarPath, {
    "net/minecraft/Example.java": "package net.minecraft;\npublic class Example {}\n"
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath }
  }) as {
    isError?: boolean;
    structuredContent?: { result?: { artifactId?: string } };
  };
  assert.notEqual(resolveResult.isError, true);
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId);

  type ToolResult = {
    isError?: boolean;
    structuredContent?: { result?: Record<string, unknown> };
  };

  const [withCompact, withoutCompact] = await Promise.all([
    callTool("search-class-source", {
      artifactId,
      query: "Example",
      intent: "symbol",
      detail: "summary"
    }) as Promise<ToolResult>,
    callTool("search-class-source", {
      artifactId,
      query: "Example",
      intent: "symbol",
      detail: "full"
    }) as Promise<ToolResult>
  ]);

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  const compactResult = withCompact.structuredContent?.result;
  const normalResult = withoutCompact.structuredContent?.result;
  assert.ok(compactResult);
  assert.ok(normalResult);

  assert.equal("artifactContents" in compactResult, false);
  assert.ok("artifactContents" in normalResult);
  assert.deepEqual(compactResult.hits, normalResult.hits);
});

test("get-runtime-metrics ignores compact:true (passthrough schema + allowlist)", async () => {
  const withCompact = await callTool("get-runtime-metrics", {
    compact: true
  }) as {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
    };
  };

  const withoutCompact = await callTool("get-runtime-metrics", {}) as {
    isError?: boolean;
    structuredContent?: {
      result?: Record<string, unknown>;
    };
  };

  assert.notEqual(withCompact.isError, true);
  assert.notEqual(withoutCompact.isError, true);

  // Both results should have the same keys — compact must NOT have stripped anything
  const keysWithCompact = Object.keys(withCompact.structuredContent?.result ?? {}).sort();
  const keysWithoutCompact = Object.keys(withoutCompact.structuredContent?.result ?? {}).sort();
  assert.deepEqual(keysWithCompact, keysWithoutCompact);
});
