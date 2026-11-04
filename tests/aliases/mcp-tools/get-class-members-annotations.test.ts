import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJar } from "../../helpers/zip.ts";
import { buildClassFile } from "../../helpers/classfile.ts";
import { callTool } from "../../helpers/mcp-tools-harness.ts";

function u2(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

type PoolApi = { addUtf8: (value: string) => number };

// annotation structure: type descriptor + zero element pairs.
function markerAnnotation(pool: PoolApi, typeDescriptor: string): Buffer {
  return Buffer.concat([u2(pool.addUtf8(typeDescriptor)), u2(0)]);
}

test("get-class-members forwards includeAnnotations through the registered MCP handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "includeannotations-"));
  const jarPath = join(root, "lib.jar");
  await createJar(jarPath, {
    "com/example/Holder.class": buildClassFile({
      internalName: "com/example/Holder",
      accessFlags: 0x0001,
      fields: [
        {
          name: "legacyField",
          descriptor: "I",
          accessFlags: 0x0001,
          attributes: [
            {
              name: "RuntimeVisibleAnnotations",
              info: (pool) =>
                Buffer.concat([u2(1), markerAnnotation(pool, "Ljava/lang/Deprecated;")])
            }
          ]
        }
      ],
      methods: [{ name: "plain", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId");

  type MembersResult = {
    structuredContent?: {
      result?: { members?: { fields?: Array<{ name?: string; annotations?: string[] }> } };
    };
  };
  const base = { target: { kind: "artifact", artifactId }, className: "com.example.Holder", access: "all" } as const;

  // Default: includeAnnotations omitted -> annotations must not appear.
  const withoutFlag = await callTool("get-class-members", base) as MembersResult;
  const plainField = withoutFlag.structuredContent?.result?.members?.fields?.find(
    (field) => field.name === "legacyField"
  );
  assert.equal(plainField?.annotations, undefined, "annotations must be absent by default");

  // Opt-in via the REGISTERED tool handler (not a direct SourceService call):
  // this is the path src/index.ts wires, which previously dropped the flag.
  const withFlag = await callTool("get-class-members", { ...base, includeAnnotations: true }) as MembersResult;
  const annotatedField = withFlag.structuredContent?.result?.members?.fields?.find(
    (field) => field.name === "legacyField"
  );
  assert.deepEqual(
    annotatedField?.annotations,
    ["@java.lang.Deprecated"],
    "includeAnnotations:true must forward through the registered tool handler and surface annotations"
  );
});
