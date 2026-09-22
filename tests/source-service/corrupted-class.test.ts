import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { MinecraftExplorerService } from "../../src/minecraft-explorer-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

import { expectAppErrorCode } from "../helpers/expect-app-error.ts";

const ACC_PUBLIC = 0x0001;

async function createExplorerJar(
  root: string,
  jarName: string,
  entries: Record<string, Buffer>
): Promise<string> {
  const jarPath = join(root, jarName);
  await createJar(jarPath, entries);
  return jarPath;
}

function createService(root: string): MinecraftExplorerService {
  return new MinecraftExplorerService(buildTestConfig(root));
}

// A truncated .class file in a real jar. ByteReader has no bounds
// checks, so cutting a well-formed class file off mid-parse makes the
// underlying Buffer reads throw a raw RangeError, which getSignature's
// primary-class path used to rethrow unchanged (-> ERR_INTERNAL).
test("MinecraftExplorerService reports a truncated primary class file as a class-corruption AppError, naming the class and jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-truncated-class-"));
  const wellFormed = buildClassFile({
    internalName: "com/example/Truncated",
    fields: [{ name: "value", descriptor: "I", accessFlags: ACC_PUBLIC }],
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  // Cut off well past the magic/version header but before the file is fully
  // read, so a Buffer read for some later field runs off the end.
  const truncated = wellFormed.subarray(0, Math.floor(wellFormed.length / 2));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Truncated.class": truncated
  });
  const service = createService(root);

  await assert.rejects(
    service.getSignature({ jarPath, fqn: "com.example.Truncated" }),
    expectAppErrorCode(ERROR_CODES.CLASS_NOT_FOUND)
  );

  let caught: unknown;
  try {
    await service.getSignature({ jarPath, fqn: "com.example.Truncated" });
  } catch (error) {
    caught = error;
  }
  const err = caught as { code?: string; message?: string };
  assert.equal(err.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.match(String(err.message), /com\.example\.Truncated/, "message must name the class");
  assert.match(String(err.message), new RegExp(jarPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "message must name the jar");
});

// parseClassFile's own deliberate throws (bad magic, unsupported
// constant-pool tag) are AppErrors too, so the getSignature wrapper's "rethrow every
// AppError unchanged" rule let them straight through as ERR_INTERNAL without
// naming the class or jar - the same underlying defect the truncated-class fix closed.
test("MinecraftExplorerService reports invalid class magic on the primary class as a class-corruption AppError, naming the class and jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-bad-magic-"));
  const invalidClass = buildClassFile({
    internalName: "com/example/BadMagic",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  invalidClass.writeUInt32BE(0x0badf00d, 0);
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/BadMagic.class": invalidClass
  });
  const service = createService(root);

  let caught: unknown;
  try {
    await service.getSignature({ jarPath, fqn: "com.example.BadMagic" });
  } catch (error) {
    caught = error;
  }
  const err = caught as { code?: string; message?: string };
  assert.equal(err.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.match(String(err.message), /com\.example\.BadMagic/, "message must name the class");
  assert.match(
    String(err.message),
    new RegExp(jarPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "message must name the jar"
  );
});

test("MinecraftExplorerService reports an unsupported constant pool tag on the primary class as a class-corruption AppError, naming the class and jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-bad-cp-tag-"));
  const invalidClass = buildClassFile({
    internalName: "com/example/BadTag",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  // Constant pool entry #1 is always the internalName's own UTF8 entry, whose
  // tag byte sits right after the 10-byte header (magic + minor + major +
  // cpCount) - see buildClassFile's addClass(spec.internalName) call.
  invalidClass[10] = 99;
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/BadTag.class": invalidClass
  });
  const service = createService(root);

  let caught: unknown;
  try {
    await service.getSignature({ jarPath, fqn: "com.example.BadTag" });
  } catch (error) {
    caught = error;
  }
  const err = caught as { code?: string; message?: string };
  assert.equal(err.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.match(String(err.message), /com\.example\.BadTag/, "message must name the class");
  assert.match(
    String(err.message),
    new RegExp(jarPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "message must name the jar"
  );
});

// ByteReader.readBytes returned a shorter-than-declared subarray
// past EOF instead of throwing (Buffer.subarray silently clips), and still
// advanced its offset by the full declared length. A primary class truncated
// inside its FINAL attribute body - attribute_length intact, trailing bytes
// missing - therefore "parsed successfully" with a silently-short body and no
// later read to ever notice the phantom over-advancement.
function buildSourceFileAttribute(fileName: string) {
  return {
    name: "SourceFile",
    info: (pool: { addUtf8: (value: string) => number }) => {
      const sourceFileIndex = pool.addUtf8(fileName);
      const body = Buffer.alloc(2);
      body.writeUInt16BE(sourceFileIndex, 0);
      return body;
    }
  };
}

test("MinecraftExplorerService reports a primary class truncated inside its final attribute body as a class-corruption AppError, naming the class and jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-truncated-attr-"));
  const wellFormed = buildClassFile({
    internalName: "com/example/TruncatedAttr",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }],
    attributes: [buildSourceFileAttribute("TruncatedAttr.java")]
  });
  // The SourceFile attribute is the last thing buildClassFile writes: its
  // declared length (2) is untouched, but its final byte is gone.
  const truncated = wellFormed.subarray(0, wellFormed.length - 1);
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/TruncatedAttr.class": truncated
  });
  const service = createService(root);

  let caught: unknown;
  try {
    await service.getSignature({ jarPath, fqn: "com.example.TruncatedAttr" });
  } catch (error) {
    caught = error;
  }
  const err = caught as { code?: string; message?: string };
  assert.equal(err.code, ERROR_CODES.CLASS_NOT_FOUND);
  assert.match(String(err.message), /com\.example\.TruncatedAttr/, "message must name the class");
  assert.match(
    String(err.message),
    new RegExp(jarPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "message must name the jar"
  );
});

test("MinecraftExplorerService still parses a complete class whose final attribute body is intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-complete-attr-"));
  const wellFormed = buildClassFile({
    internalName: "com/example/CompleteAttr",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }],
    attributes: [buildSourceFileAttribute("CompleteAttr.java")]
  });
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/CompleteAttr.class": wellFormed
  });
  const service = createService(root);

  const result = await service.getSignature({ jarPath, fqn: "com.example.CompleteAttr" });
  assert.equal(result.constructors.length, 1);
});

// The inherited-class path already degrades a broken superclass/interface
// read into a warning instead of a hard failure; the truncated-class fix must not change that.
test("MinecraftExplorerService still degrades a truncated inherited class file into a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-truncated-super-"));
  const child = buildClassFile({
    internalName: "com/example/Child",
    superInternalName: "com/example/Truncated",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  const wellFormedSuper = buildClassFile({
    internalName: "com/example/Truncated",
    fields: [{ name: "value", descriptor: "I", accessFlags: ACC_PUBLIC }],
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  const truncatedSuper = wellFormedSuper.subarray(0, Math.floor(wellFormedSuper.length / 2));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Child.class": child,
    "com/example/Truncated.class": truncatedSuper
  });
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Child",
    includeInherited: true
  });
  assert.ok(
    result.warnings?.some((warning) => warning.includes("com.example.Truncated")),
    `expected a warning naming the unreadable super class, got: ${JSON.stringify(result.warnings)}`
  );
});

// A malformed bytecode descriptor on a member must not blame the
// caller (ERR_INVALID_INPUT) - it is third-party jar content, not tool input.
test("MinecraftExplorerService reports a malformed field descriptor as a class-corruption AppError, not ERR_INVALID_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-bad-field-descriptor-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/FieldDescriptor.class": buildClassFile({
      internalName: "com/example/FieldDescriptor",
      fields: [{ name: "broken", descriptor: "V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  await assert.rejects(
    service.getSignature({ jarPath, fqn: "com.example.FieldDescriptor", access: "all" }),
    expectAppErrorCode(ERROR_CODES.CLASS_NOT_FOUND)
  );
});

test("MinecraftExplorerService reports a malformed method descriptor as a class-corruption AppError, not ERR_INVALID_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-bad-method-descriptor-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/MethodDescriptor.class": buildClassFile({
      internalName: "com/example/MethodDescriptor",
      methods: [{ name: "broken", descriptor: "(I)Vextra", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  await assert.rejects(
    service.getSignature({ jarPath, fqn: "com.example.MethodDescriptor", access: "all" }),
    expectAppErrorCode(ERROR_CODES.CLASS_NOT_FOUND)
  );
});
