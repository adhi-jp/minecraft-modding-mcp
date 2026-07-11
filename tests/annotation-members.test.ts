import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../src/source-service.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

function u1(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}
function u2(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

type PoolApi = {
  addUtf8: (value: string) => number;
  addInteger: (value: number) => number;
  addFloat: (value: number) => number;
  addLong: (value: bigint) => number;
  addDouble: (value: number) => number;
};

// element_value with tag 's' (String constant).
function stringElementValue(pool: PoolApi, value: string): Buffer {
  return Buffer.concat([u1("s".charCodeAt(0)), u2(pool.addUtf8(value))]);
}

// annotation structure: type descriptor + zero element pairs.
function markerAnnotation(pool: PoolApi, typeDescriptor: string): Buffer {
  return Buffer.concat([u2(pool.addUtf8(typeDescriptor)), u2(0)]);
}

async function buildAnnotationJar(): Promise<{ jarPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "annotation-members-"));
  const jarPath = join(root, "annotations.jar");
  await createJar(jarPath, {
    // @interface ExampleAnnotation { String value() default "stone"; }
    "com/example/ExampleAnnotation.class": buildClassFile({
      internalName: "com/example/ExampleAnnotation",
      // 0x2601 = public | interface | abstract | annotation
      accessFlags: 0x2601,
      interfaceInternalNames: ["java/lang/annotation/Annotation"],
      methods: [
        {
          name: "value",
          descriptor: "()Ljava/lang/String;",
          accessFlags: 0x0401,
          attributes: [
            {
              name: "AnnotationDefault",
              info: (pool) => stringElementValue(pool, "stone")
            }
          ]
        }
      ]
    }),
    // class Holder { @Deprecated int legacyField; void plain() {} }
    "com/example/Holder.class": buildClassFile({
      internalName: "com/example/Holder",
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
  return { jarPath, root };
}

test("annotation-type classes expose member default values", async () => {
  const { jarPath, root } = await buildAnnotationJar();
  const service = new SourceService(buildTestConfig(root));

  const signature = await service.explorerService.getSignature({
    fqn: "com.example.ExampleAnnotation",
    jarPath,
    access: "all"
  });

  const valueMember = signature.methods.find((method) => method.name === "value");
  assert.ok(valueMember);
  assert.equal(valueMember?.annotationDefault, '"stone"');
});

test("member annotations appear only under the opt-in projection of get-class-members", async () => {
  const { jarPath, root } = await buildAnnotationJar();
  const service = new SourceService(buildTestConfig(root));
  // Adjacent sources jar so the artifact resolves source-backed.
  await createJar(join(root, "annotations-sources.jar"), {
    "com/example/Holder.java": "package com.example;\npublic class Holder {}\n"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: jarPath },
    mapping: "obfuscated"
  });

  // Plain first, opt-in second: the strip runs on the cached signature
  // before the annotated read, so an in-place mutation would surface here.
  const withoutAnnotations = await service.getClassMembers({
    className: "com.example.Holder",
    artifactId: resolved.artifactId
  });
  const plainField = withoutAnnotations.members.fields.find(
    (field) => field.name === "legacyField"
  ) as { annotations?: string[] } | undefined;
  assert.equal(plainField?.annotations, undefined);

  const withAnnotations = await service.getClassMembers({
    className: "com.example.Holder",
    artifactId: resolved.artifactId,
    includeAnnotations: true
  });
  const annotatedField = withAnnotations.members.fields.find(
    (field) => field.name === "legacyField"
  ) as { annotations?: string[] } | undefined;
  assert.deepEqual(annotatedField?.annotations, ["@java.lang.Deprecated"]);
});

test("numeric annotation defaults render from retained constant-pool values", async () => {
  const root = await mkdtemp(join(tmpdir(), "annotation-numeric-"));
  const jarPath = join(root, "numeric.jar");
  await createJar(jarPath, {
    "com/example/Numeric.class": buildClassFile({
      internalName: "com/example/Numeric",
      accessFlags: 0x2601,
      interfaceInternalNames: ["java/lang/annotation/Annotation"],
      methods: [
        {
          name: "limit",
          descriptor: "()I",
          accessFlags: 0x0401,
          attributes: [
            {
              name: "AnnotationDefault",
              // tag 'I' referencing a retained CONSTANT_Integer pool value.
              info: (pool) => Buffer.concat([u1("I".charCodeAt(0)), u2(pool.addInteger(42))])
            }
          ]
        }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "com.example.Numeric",
    jarPath,
    access: "all"
  });
  const limitMember = signature.methods.find((method) => method.name === "limit");
  assert.equal(limitMember?.annotationDefault, "42");
});


test("complex annotation defaults render every element_value shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "annotation-complex-"));
  const jarPath = join(root, "complex.jar");
  await createJar(jarPath, {
    "com/example/Complex.class": buildClassFile({
      internalName: "com/example/Complex",
      accessFlags: 0x2601,
      interfaceInternalNames: ["java/lang/annotation/Annotation"],
      methods: [
        {
          name: "settings",
          descriptor: "()Lcom/example/Nested;",
          accessFlags: 0x0401,
          attributes: [
            {
              name: "AnnotationDefault",
              info: (pool) =>
                Buffer.concat([
                  u1("@".charCodeAt(0)),
                  u2(pool.addUtf8("Lcom/example/Nested;")),
                  u2(8),
                  u2(pool.addUtf8("mode")),
                  u1("e".charCodeAt(0)),
                  u2(pool.addUtf8("Lcom/example/Mode;")),
                  u2(pool.addUtf8("FAST")),
                  u2(pool.addUtf8("type")),
                  u1("c".charCodeAt(0)),
                  u2(pool.addUtf8("Ljava/lang/String;")),
                  u2(pool.addUtf8("flag")),
                  u1("Z".charCodeAt(0)),
                  u2(pool.addInteger(1)),
                  u2(pool.addUtf8("letter")),
                  u1("C".charCodeAt(0)),
                  u2(pool.addInteger(65)),
                  u2(pool.addUtf8("ratio")),
                  u1("D".charCodeAt(0)),
                  u2(pool.addDouble(2.5)),
                  u2(pool.addUtf8("big")),
                  u1("J".charCodeAt(0)),
                  u2(pool.addLong(9999999999n)),
                  u2(pool.addUtf8("factor")),
                  u1("F".charCodeAt(0)),
                  u2(pool.addFloat(1.5)),
                  u2(pool.addUtf8("tags")),
                  u1("[".charCodeAt(0)),
                  u2(2),
                  u1("s".charCodeAt(0)),
                  u2(pool.addUtf8("a")),
                  u1("s".charCodeAt(0)),
                  u2(pool.addUtf8("b"))
                ])
            }
          ]
        }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "com.example.Complex",
    jarPath,
    access: "all"
  });
  const member = signature.methods.find((method) => method.name === "settings");
  assert.equal(
    member?.annotationDefault,
    "@com.example.Nested(mode = com.example.Mode.FAST, type = java.lang.String.class, " +
      "flag = true, letter = 'A', ratio = 2.5, big = 9999999999, factor = 1.5, tags = {\"a\", \"b\"})"
  );
});

test("a malformed annotation attribute degrades to absent metadata without failing the parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "annotation-malformed-"));
  const jarPath = join(root, "malformed.jar");
  await createJar(jarPath, {
    "com/example/Broken.class": buildClassFile({
      internalName: "com/example/Broken",
      accessFlags: 0x2601,
      interfaceInternalNames: ["java/lang/annotation/Annotation"],
      methods: [
        {
          name: "value",
          descriptor: "()Ljava/lang/String;",
          accessFlags: 0x0401,
          attributes: [
            { name: "AnnotationDefault", info: Buffer.from([0x73]) },
            { name: "RuntimeVisibleAnnotations", info: Buffer.from([0xff, 0xff, 0x00]) }
          ]
        }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "com.example.Broken",
    jarPath,
    access: "all"
  });
  const member = signature.methods.find((method) => method.name === "value");
  assert.ok(member, "the class must still parse");
  assert.equal(member?.annotationDefault, undefined);
  assert.equal((member as { annotations?: string[] }).annotations, undefined);
});
