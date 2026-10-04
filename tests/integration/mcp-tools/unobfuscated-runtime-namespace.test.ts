import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildClassFile } from "../../helpers/classfile.ts";
import { callTool } from "../../helpers/mcp-tools-harness.ts";
import { createJar } from "../../helpers/zip.ts";

/**
 * On a proven Minecraft 26.1+ runtime the as-shipped names ARE the Mojang names,
 * so tool responses report `mojang` where the internal label is `obfuscated`.
 * A jar counts as such a runtime only on in-jar proof: a root version.json whose
 * id is a 26.1+ version and net/minecraft/SharedConstants.class, with no .java
 * sources. The same jar with a legacy id is the before-state control.
 */

const ITEM = "net.minecraft.world.item.Item";

async function writeRuntimeJar(versionId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `runtime-namespace-${versionId}-`));
  const jarPath = join(root, "client.jar");
  await createJar(jarPath, {
    "version.json": JSON.stringify({ id: versionId, name: versionId }),
    "net/minecraft/SharedConstants.class": buildClassFile({
      internalName: "net/minecraft/SharedConstants",
      accessFlags: 0x0001
    }),
    "net/minecraft/world/item/Item.class": buildClassFile({
      internalName: "net/minecraft/world/item/Item",
      accessFlags: 0x0001,
      methods: [{ name: "getDescriptionId", descriptor: "()Ljava/lang/String;", accessFlags: 0x0001 }]
    })
  });
  return jarPath;
}

type ToolResult = { structuredContent?: { result?: Record<string, unknown> }; isError?: boolean };

async function resultOf(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = (await callTool(name, args)) as ToolResult;
  assert.notEqual(response.isError, true, `${name} failed: ${JSON.stringify(response)}`);
  const result = response.structuredContent?.result;
  assert.ok(result, `${name} returned no structured result: ${JSON.stringify(response)}`);
  return result;
}

async function resolveJar(jarPath: string, mapping?: "obfuscated" | "mojang") {
  return resultOf("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    ...(mapping ? { mapping } : {})
  });
}

test("resolve-artifact reports mojang on a proven 26.x runtime jar whether mapping is omitted or obfuscated", async () => {
  const jarPath = await writeRuntimeJar("26.2");

  const omitted = await resolveJar(jarPath);
  const obfuscated = await resolveJar(jarPath, "obfuscated");

  assert.equal(omitted.mappingApplied, "mojang");
  assert.equal(obfuscated.mappingApplied, "mojang");
  // requestedMapping keeps echoing the caller's input: obfuscated -> mojang is an
  // identity on these runtimes, not a fallback.
  assert.equal(obfuscated.requestedMapping, "obfuscated");
  assert.equal(omitted.version, "26.2");
});

test("resolve-artifact keeps the obfuscated label on a jar whose version.json names a legacy release", async () => {
  const jarPath = await writeRuntimeJar("1.21.10");

  const resolved = await resolveJar(jarPath, "obfuscated");

  assert.equal(resolved.mappingApplied, "obfuscated");
});

test("class and file tools report mojang for an artifact resolved from a proven 26.x runtime jar", async () => {
  const jarPath = await writeRuntimeJar("26.2");
  const artifactId = (await resolveJar(jarPath)).artifactId;
  assert.equal(typeof artifactId, "string");
  const target = { kind: "artifact", artifactId };

  const source = await resultOf("get-class-source", { target, className: ITEM, mode: "metadata" });
  const members = await resultOf("get-class-members", { target, className: ITEM });
  const search = await resultOf("search-class-source", { artifactId, query: "Item" });
  const files = await resultOf("list-artifact-files", { artifactId });
  const file = await resultOf("get-artifact-file", { artifactId, filePath: "net/minecraft/world/item/Item.java" });
  const indexed = await resultOf("index-artifact", { artifactId });

  assert.equal(source.mappingApplied, "mojang");
  assert.equal(source.returnedNamespace, "mojang");
  assert.equal(members.mappingApplied, "mojang");
  assert.equal(members.returnedNamespace, "mojang");
  assert.equal((members.context as { mappingNamespace?: string }).mappingNamespace, "mojang");
  assert.equal(search.mappingApplied, "mojang");
  assert.equal(search.returnedNamespace, "mojang");
  assert.equal(files.mappingApplied, "mojang");
  assert.equal(file.mappingApplied, "mojang");
  assert.equal(file.returnedNamespace, "mojang");
  assert.equal(indexed.mappingApplied, "mojang");
});

test("inspect-minecraft task=artifact reports mojang for a proven 26.x runtime jar and obfuscated for an unproven one", async () => {
  const inspect = async (jarPath: string) => {
    const response = (await callTool("inspect-minecraft", {
      task: "artifact",
      subject: { kind: "artifact", artifact: { type: "resolve-target", target: { kind: "jar", value: jarPath } } },
      detail: "standard"
    })) as { structuredContent?: { result?: { artifact?: { mappingApplied?: string } } } };
    return response.structuredContent?.result?.artifact?.mappingApplied;
  };

  assert.equal(await inspect(await writeRuntimeJar("26.2")), "mojang");
  assert.equal(await inspect(await writeRuntimeJar("1.21.10")), "obfuscated");
});

test("class and file tools keep the obfuscated label for an artifact resolved from an unproven jar", async () => {
  const jarPath = await writeRuntimeJar("1.21.10");
  const artifactId = (await resolveJar(jarPath, "obfuscated")).artifactId;
  const target = { kind: "artifact", artifactId };

  const source = await resultOf("get-class-source", { target, className: ITEM, mode: "metadata" });
  const members = await resultOf("get-class-members", { target, className: ITEM });
  const files = await resultOf("list-artifact-files", { artifactId });

  assert.equal(source.mappingApplied, "obfuscated");
  assert.equal(members.returnedNamespace, "obfuscated");
  assert.equal((members.context as { mappingNamespace?: string }).mappingNamespace, "obfuscated");
  assert.equal(files.mappingApplied, "obfuscated");
});

test("get-class-members and verify-mixin-target accept the reported mojang back on a proven 26.x runtime jar", async () => {
  const jarPath = await writeRuntimeJar("26.2");
  const target = { kind: "jar", value: jarPath };
  const member = { kind: "method", name: "getDescriptionId", descriptor: "()Ljava/lang/String;" };

  const sourceAsReported = await resultOf("get-class-source", { target, className: ITEM, mode: "full" });
  const sourceSentBack = await resultOf("get-class-source", { target, className: ITEM, mode: "full", mapping: "mojang" });
  assert.equal(sourceAsReported.mappingApplied, "mojang");
  assert.equal(sourceSentBack.mappingApplied, "mojang");
  assert.equal(sourceSentBack.sourceText, sourceAsReported.sourceText);

  const asReported = await resultOf("get-class-members", { target, className: ITEM });
  const sentBack = await resultOf("get-class-members", { target, className: ITEM, mapping: "mojang" });
  assert.equal(asReported.returnedNamespace, "mojang");
  assert.equal(sentBack.returnedNamespace, "mojang");
  assert.deepEqual(sentBack.members, asReported.members);
  assert.deepEqual(sentBack.counts, asReported.counts);

  const verifyOmitted = await resultOf("verify-mixin-target", { target, owner: ITEM, member });
  const verifyMojang = await resultOf("verify-mixin-target", { target, owner: ITEM, member, mapping: "mojang" });
  for (const verified of [verifyOmitted, verifyMojang]) {
    assert.equal(verified.exists, true);
    assert.deepEqual(verified.resolvedOwner, { className: ITEM, mapping: "mojang" });
    assert.equal((verified.provenance as { mappingNamespace?: string }).mappingNamespace, "mojang");
  }
});
