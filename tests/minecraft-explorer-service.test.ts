import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { MinecraftExplorerService } from "../src/minecraft-explorer-service.ts";
import type { Config } from "../src/types.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { createJar } from "./helpers/zip.ts";

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_SYNTHETIC = 0x1000;

function buildTestConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    tinyRemapperJarPath: undefined,
    remapTimeoutMs: 600_000,
    remapMaxMemoryMb: 4_096,
    ...overrides
  };
}

async function createExplorerJar(
  root: string,
  jarName: string,
  entries: Record<string, Buffer>
): Promise<string> {
  const jarPath = join(root, jarName);
  await createJar(jarPath, entries);
  return jarPath;
}

function createService(root: string, overrides: Partial<Config> = {}): MinecraftExplorerService {
  return new MinecraftExplorerService(buildTestConfig(root, overrides));
}

function readU2(buffer: Buffer, offset: number): number {
  return buffer.readUInt16BE(offset);
}

function readU4(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

function inspectClassFile(buffer: Buffer): {
  constantPoolTagOffsets: Array<number | undefined>;
  thisClassOffset: number;
  fieldDescriptorIndexOffsets: number[];
} {
  let offset = 0;
  offset += 4;
  offset += 2;
  offset += 2;
  const constantPoolCount = readU2(buffer, offset);
  offset += 2;

  const constantPoolTagOffsets: Array<number | undefined> = new Array(constantPoolCount);
  for (let index = 1; index < constantPoolCount; index += 1) {
    constantPoolTagOffsets[index] = offset;
    const tag = buffer.readUInt8(offset);
    offset += 1;
    switch (tag) {
      case 1: {
        const length = readU2(buffer, offset);
        offset += 2 + length;
        break;
      }
      case 3:
      case 4:
        offset += 4;
        break;
      case 5:
      case 6:
        offset += 8;
        index += 1;
        break;
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        offset += 2;
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        offset += 4;
        break;
      case 15:
        offset += 3;
        break;
      default:
        throw new Error(`Unsupported tag ${tag} while inspecting class file test fixture.`);
    }
  }

  offset += 2;
  const thisClassOffset = offset;
  offset += 2;
  offset += 2;

  const interfacesCount = readU2(buffer, offset);
  offset += 2 + interfacesCount * 2;

  const fieldsCount = readU2(buffer, offset);
  offset += 2;
  const fieldDescriptorIndexOffsets: number[] = [];
  for (let index = 0; index < fieldsCount; index += 1) {
    offset += 2;
    offset += 2;
    fieldDescriptorIndexOffsets.push(offset);
    offset += 2;
    const attributesCount = readU2(buffer, offset);
    offset += 2;
    for (let attributeIndex = 0; attributeIndex < attributesCount; attributeIndex += 1) {
      offset += 2;
      const length = readU4(buffer, offset);
      offset += 4 + length;
    }
  }

  return {
    constantPoolTagOffsets,
    thisClassOffset,
    fieldDescriptorIndexOffsets
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
  message: RegExp
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.equal((error as { code?: string }).code, code);
    assert.match((error as Error).message, message);
    return true;
  });
}

test("MinecraftExplorerService reports invalid class magic as ERR_INTERNAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-invalid-magic-"));
  const invalidClass = buildClassFile({
    internalName: "com/example/Broken",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  invalidClass.writeUInt32BE(0x0badf00d, 0);
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Broken.class": invalidClass
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.Broken" }),
    ERROR_CODES.INTERNAL,
    /Invalid class file magic/
  );
});

test("MinecraftExplorerService reports unsupported constant pool tags as ERR_INTERNAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-invalid-cp-tag-"));
  const invalidClass = buildClassFile({
    internalName: "com/example/BrokenTag",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  const offsets = inspectClassFile(invalidClass);
  invalidClass[offsets.constantPoolTagOffsets[1] as number] = 99;
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/BrokenTag.class": invalidClass
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.BrokenTag" }),
    ERROR_CODES.INTERNAL,
    /Unsupported constant pool tag 99/
  );
});

test("MinecraftExplorerService maps broken constant-pool references to class-safe errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-invalid-cp-ref-"));
  const invalidClassRef = buildClassFile({
    internalName: "com/example/BrokenRef",
    methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
  });
  const classRefOffsets = inspectClassFile(invalidClassRef);
  invalidClassRef.writeUInt16BE(1, classRefOffsets.thisClassOffset);
  const invalidUtf8Ref = buildClassFile({
    internalName: "com/example/BrokenUtf8",
    fields: [{ name: "value", descriptor: "I", accessFlags: ACC_PUBLIC }]
  });
  const utf8Offsets = inspectClassFile(invalidUtf8Ref);
  invalidUtf8Ref.writeUInt16BE(999, utf8Offsets.fieldDescriptorIndexOffsets[0] as number);

  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/BrokenRef.class": invalidClassRef,
    "com/example/BrokenUtf8.class": invalidUtf8Ref
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.BrokenRef" }),
    ERROR_CODES.CLASS_NOT_FOUND,
    /Invalid class constant pool index/
  );
  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.BrokenUtf8" }),
    ERROR_CODES.CLASS_NOT_FOUND,
    /Invalid UTF8 constant pool index/
  );
});

test("MinecraftExplorerService rejects malformed field descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-invalid-field-descriptor-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/FieldDescriptor.class": buildClassFile({
      internalName: "com/example/FieldDescriptor",
      fields: [{ name: "broken", descriptor: "V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.FieldDescriptor", access: "all" }),
    ERROR_CODES.INVALID_INPUT,
    /Invalid field descriptor/
  );
});

test("MinecraftExplorerService rejects malformed method descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-invalid-method-descriptor-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/MethodDescriptor.class": buildClassFile({
      internalName: "com/example/MethodDescriptor",
      methods: [{ name: "broken", descriptor: "(I)Vextra", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.MethodDescriptor", access: "all" }),
    ERROR_CODES.INVALID_INPUT,
    /Invalid method descriptor/
  );
});

test("MinecraftExplorerService renders arrays, objects, primitives, and void signatures", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-descriptor-rendering-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Render.class": buildClassFile({
      internalName: "com/example/Render",
      fields: [
        { name: "counts", descriptor: "[[I", accessFlags: ACC_PUBLIC },
        { name: "name", descriptor: "Ljava/lang/String;", accessFlags: ACC_PUBLIC }
      ],
      methods: [
        { name: "<init>", descriptor: "([Ljava/lang/String;)V", accessFlags: ACC_PUBLIC },
        { name: "merge", descriptor: "([ILjava/lang/String;Z)I", accessFlags: ACC_PUBLIC | ACC_STATIC },
        { name: "reset", descriptor: "()V", accessFlags: ACC_PROTECTED }
      ]
    })
  });
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Render",
    access: "all"
  });

  assert.deepEqual(
    result.fields.map((field) => field.javaSignature),
    ["public int[][] counts", "public java.lang.String name"]
  );
  assert.deepEqual(
    result.constructors.map((member) => member.javaSignature),
    ["public Render(java.lang.String[])"]
  );
  assert.deepEqual(
    result.methods.map((member) => member.javaSignature),
    ["public static int merge(int[], java.lang.String, boolean)", "protected void reset()"]
  );
});

test("MinecraftExplorerService expands inherited superclass and interface members", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-inherited-members-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      superInternalName: "com/example/Parent",
      interfaceInternalNames: ["com/example/Primary"],
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }],
      fields: [{ name: "childValue", descriptor: "I", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Parent.class": buildClassFile({
      internalName: "com/example/Parent",
      superInternalName: undefined,
      interfaceInternalNames: ["com/example/Secondary"],
      fields: [{ name: "parentValue", descriptor: "I", accessFlags: ACC_PROTECTED }],
      methods: [{ name: "inheritedMethod", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Primary.class": buildClassFile({
      internalName: "com/example/Primary",
      superInternalName: undefined,
      methods: [{ name: "primaryMethod", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Secondary.class": buildClassFile({
      internalName: "com/example/Secondary",
      superInternalName: undefined,
      fields: [{ name: "secondaryFlag", descriptor: "Z", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Child",
    includeInherited: true
  });

  assert.deepEqual(
    result.fields.map((field) => `${field.ownerFqn}:${field.name}`),
    [
      "com.example.Child:childValue",
      "com.example.Parent:parentValue",
      "com.example.Secondary:secondaryFlag"
    ]
  );
  assert.deepEqual(
    result.methods.map((method) => `${method.ownerFqn}:${method.name}`),
    ["com.example.Parent:inheritedMethod", "com.example.Primary:primaryMethod"]
  );
  assert.deepEqual(result.warnings, []);
});

test("MinecraftExplorerService warns when inherited classes or interfaces are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-missing-hierarchy-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      superInternalName: "com/example/MissingParent",
      interfaceInternalNames: ["com/example/MissingInterface"],
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Child",
    includeInherited: true
  });

  assert.deepEqual(result.warnings, [
    'Could not resolve super class "com.example.MissingParent" while expanding inherited members.',
    'Could not resolve interface class "com.example.MissingInterface" while expanding inherited members.'
  ]);
});

test("MinecraftExplorerService detects class hierarchy cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-cycle-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/CycleStart.class": buildClassFile({
      internalName: "com/example/CycleStart",
      superInternalName: "com/example/CycleMiddle",
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/CycleMiddle.class": buildClassFile({
      internalName: "com/example/CycleMiddle",
      superInternalName: "com/example/CycleStart"
    })
  });
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.CycleStart",
    includeInherited: true
  });

  assert.deepEqual(result.warnings, ['Detected class hierarchy cycle at "com.example.CycleStart".']);
});

test("MinecraftExplorerService stops inherited expansion at max depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-max-depth-"));
  const entries: Record<string, Buffer> = {};
  for (let index = 0; index <= 65; index += 1) {
    const internalName = `com/example/Depth${index}`;
    const superInternalName = index === 65 ? undefined : `com/example/Depth${index + 1}`;
    entries[`${internalName}.class`] = buildClassFile({
      internalName,
      superInternalName,
      methods: index === 0 ? [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }] : []
    });
  }
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", entries);
  const service = createService(root);

  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Depth0",
    includeInherited: true
  });

  assert.deepEqual(result.warnings, [
    'Stopped inherited member expansion at depth 64 while resolving "com.example.Depth0".'
  ]);
});

test("MinecraftExplorerService filters by access, synthetic flag, and member pattern", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-filtering-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Filter.class": buildClassFile({
      internalName: "com/example/Filter",
      fields: [
        { name: "publicField", descriptor: "I", accessFlags: ACC_PUBLIC },
        { name: "protectedField", descriptor: "I", accessFlags: ACC_PROTECTED },
        { name: "hiddenField", descriptor: "I", accessFlags: ACC_PRIVATE },
        { name: "syntheticField", descriptor: "I", accessFlags: ACC_PUBLIC | ACC_SYNTHETIC }
      ],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "visibleMethod", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "helperMethod", descriptor: "()V", accessFlags: ACC_PRIVATE },
        { name: "syntheticMethod", descriptor: "()V", accessFlags: ACC_PUBLIC | ACC_SYNTHETIC }
      ]
    })
  });
  const service = createService(root);

  const publicOnly = await service.getSignature({
    jarPath,
    fqn: "com.example.Filter"
  });
  assert.deepEqual(publicOnly.fields.map((field) => field.name), ["publicField", "protectedField"]);
  assert.deepEqual(publicOnly.methods.map((method) => method.name), ["visibleMethod"]);
  assert.deepEqual(publicOnly.constructors.map((member) => member.name), ["<init>"]);

  const allMembers = await service.getSignature({
    jarPath,
    fqn: "com.example.Filter",
    access: "all",
    includeSynthetic: true,
    memberPattern: "field"
  });
  assert.deepEqual(allMembers.fields.map((field) => field.name), [
    "publicField",
    "protectedField",
    "hiddenField",
    "syntheticField"
  ]);
  assert.deepEqual(allMembers.methods, []);
  assert.deepEqual(allMembers.constructors, []);
});

test("MinecraftExplorerService reuses cached signatures but refreshes response context", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-cache-"));
  const jarPath = join(root, "demo-1.21.4.jar");
  const firstJar = {
    "com/example/Cached.class": buildClassFile({
      internalName: "com/example/Cached",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "first", descriptor: "()V", accessFlags: ACC_PUBLIC }
      ]
    })
  };
  await createJar(jarPath, firstJar);
  const service = createService(root, { maxSignatureCache: 1 });

  const first = await service.getSignature({ jarPath, fqn: "com.example.Cached" });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await createJar(jarPath, {
    "com/example/Cached.class": buildClassFile({
      internalName: "com/example/Cached",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "second", descriptor: "()V", accessFlags: ACC_PUBLIC }
      ]
    }),
    "com/example/Extra.class": buildClassFile({ internalName: "com/example/Extra" })
  });
  await writeFile(join(root, "touch.txt"), "cache-bust");

  const second = await service.getSignature({ jarPath, fqn: "com.example.Cached" });

  assert.deepEqual(first.methods.map((method) => method.name), ["first"]);
  assert.deepEqual(second.methods.map((method) => method.name), ["first"]);
  assert.notEqual(second.context.generatedAt, first.context.generatedAt);
  assert.notEqual(second.context.jarHash, first.context.jarHash);
});
