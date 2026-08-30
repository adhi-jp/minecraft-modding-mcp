import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { MinecraftExplorerService } from "../../src/minecraft-explorer-service.ts";
import { __getZipOpenCount, __resetZipOpenCount } from "../../src/source-jar-reader.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_SYNTHETIC = 0x1000;

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

test("MinecraftExplorerService reports void method arguments as invalid method descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-void-method-arg-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/VoidMethodArg.class": buildClassFile({
      internalName: "com/example/VoidMethodArg",
      methods: [{ name: "broken", descriptor: "([V)I", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  await expectAppError(
    service.getSignature({ jarPath, fqn: "com.example.VoidMethodArg", access: "all" }),
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
    "java/lang/Object.class": buildClassFile({ internalName: "java/lang/Object" }),
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      superInternalName: "com/example/Parent",
      interfaceInternalNames: ["com/example/Primary"],
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }],
      fields: [{ name: "childValue", descriptor: "I", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Parent.class": buildClassFile({
      internalName: "com/example/Parent",
      interfaceInternalNames: ["com/example/Secondary"],
      fields: [{ name: "parentValue", descriptor: "I", accessFlags: ACC_PROTECTED }],
      methods: [{ name: "inheritedMethod", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Primary.class": buildClassFile({
      internalName: "com/example/Primary",
      methods: [{ name: "primaryMethod", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Secondary.class": buildClassFile({
      internalName: "com/example/Secondary",
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

test("getSignature opens the jar once for the whole inheritance hierarchy", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-getsignature-open-count-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "java/lang/Object.class": buildClassFile({ internalName: "java/lang/Object" }),
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      superInternalName: "com/example/Parent",
      interfaceInternalNames: ["com/example/Primary"],
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }],
      fields: [{ name: "childValue", descriptor: "I", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Parent.class": buildClassFile({
      internalName: "com/example/Parent",
      interfaceInternalNames: ["com/example/Secondary"],
      fields: [{ name: "parentValue", descriptor: "I", accessFlags: ACC_PROTECTED }]
    }),
    "com/example/Primary.class": buildClassFile({
      internalName: "com/example/Primary",
      methods: [{ name: "primaryMethod", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    }),
    "com/example/Secondary.class": buildClassFile({
      internalName: "com/example/Secondary",
      fields: [{ name: "secondaryFlag", descriptor: "Z", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  __resetZipOpenCount();
  const result = await service.getSignature({
    jarPath,
    fqn: "com.example.Child",
    includeInherited: true
  });

  // The entire super/interface hierarchy is read through ONE jar open
  // (previously one yauzl.open per distinct class in the hierarchy).
  assert.equal(__getZipOpenCount(), 1);
  // Parity: inherited members are still resolved through the single-open reader.
  assert.ok(
    result.fields.some((field) => field.ownerFqn === "com.example.Parent" && field.name === "parentValue")
  );
  assert.ok(
    result.methods.some((method) => method.ownerFqn === "com.example.Primary" && method.name === "primaryMethod")
  );
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
      ...(superInternalName ? { superInternalName } : {}),
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

test("MinecraftExplorerService treats memberPattern \"|\" as OR alternatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-or-pattern-"));
  const jarPath = await createExplorerJar(root, "demo-1.21.4.jar", {
    "com/example/Block.class": buildClassFile({
      internalName: "com/example/Block",
      fields: [],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "getStateForPlacement", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "canSurvive", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "setPlacedBy", descriptor: "()V", accessFlags: ACC_PUBLIC },
        { name: "unrelated", descriptor: "()V", accessFlags: ACC_PUBLIC }
      ]
    })
  });
  const service = createService(root);

  // Regression guard: a piped pattern previously matched a literal "|" and
  // returned zero. It must now match every alternative.
  const matched = await service.getSignature({
    jarPath,
    fqn: "com.example.Block",
    memberPattern: "getStateForPlacement|canSurvive|setPlacedBy"
  });
  assert.deepEqual(matched.methods.map((method) => method.name).sort(), [
    "canSurvive",
    "getStateForPlacement",
    "setPlacedBy"
  ]);
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
  assert.notEqual(second.context.jarSignature, first.context.jarSignature);
});

test("MinecraftExplorerService avoids delete/set churn and spread copies on cache hits", async () => {
  const source = await readFile(new URL("../../src/minecraft-explorer-service.ts", import.meta.url), "utf8");
  const block =
    source.match(/const cached = this\.signatureCache\.get\(cacheKey\);[\s\S]*?const classEntryPath =/)?.[0] ?? "";

  assert.doesNotMatch(block, /this\.signatureCache\.delete\(cacheKey\);\s*this\.signatureCache\.set\(cacheKey, cached\);/);
  assert.doesNotMatch(block, /return\s*\{\s*\.\.\.cached,/);
});

test("MinecraftExplorerService reports unknown minecraftVersion for a dependency-origin jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-dep-origin-"));
  // Real Gradle cache layout. The first "N.N" substring in this path is the
  // "files-2.1" cache-layout constant, and the next candidate is the
  // dependency's own coordinate version - neither is a Minecraft version.
  const cacheDir = join(
    root,
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef"
  );
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar");
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);
  const fqn = "net.fabricmc.fabric.api.gametest.v1.FabricGameTest";

  // The path read now declines this Gradle-cache path on its own, so the flag is
  // no longer the only thing standing between the caller and the "2.1" layout
  // constant. It still has to hold independently, which is what the rest of this
  // test pins; the store-shaped path is covered directly further down.
  const unflagged = await service.getSignature({ jarPath, fqn });
  assert.equal(unflagged.context.minecraftVersion, "unknown");

  const flagged = await service.getSignature({ jarPath, fqn, dependencyOrigin: true });
  assert.equal(flagged.context.minecraftVersion, "unknown");
  assert.equal(flagged.context.mappingNamespace, "obfuscated");

  // contextForJar runs on cache hits too, so the flag must hold there as well.
  const cachedHit = await service.getSignature({ jarPath, fqn, dependencyOrigin: true });
  assert.equal(cachedHit.context.minecraftVersion, "unknown");
  assert.equal(cachedHit.context.mappingNamespace, "obfuscated");
});

// A jar named directly by path carries no coordinate, so nothing but the path
// itself can say whether its numbers are Minecraft's. Gradle's dependency cache
// and a local Maven repository both serve third-party jars from a layout whose
// leading number belongs to the layout ("files-2.1") or to the library, so a
// version read out of either is a plausible-looking wrong answer. The three
// tests below pin the refusal and, just as importantly, the two shapes it must
// NOT refuse.
async function signatureVersionForJarPath(
  root: string,
  jarPath: string,
  internalName: string
): Promise<string> {
  await mkdir(dirname(jarPath), { recursive: true });
  await createJar(jarPath, {
    [`${internalName}.class`]: buildClassFile({
      internalName,
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    })
  });
  const signature = await createService(root).getSignature({
    jarPath,
    fqn: internalName.replace(/\//g, ".")
  });
  return signature.context.minecraftVersion;
}

test("MinecraftExplorerService reports unknown minecraftVersion for a jar named directly out of the Gradle dependency cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-gradle-cache-path-"));
  const jarPath = join(
    root,
    "caches",
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef",
    "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar"
  );

  const version = await signatureVersionForJarPath(
    root,
    jarPath,
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest"
  );

  assert.equal(version, "unknown");
  assert.notEqual(version, "2.1", "the cache layout constant is not a Minecraft version");
  assert.notEqual(version, "4.0.21", "the library's own release number is not one either");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a jar named directly out of a local Maven repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-local-m2-path-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "org",
    "jetbrains",
    "annotations",
    "26.0.2",
    "annotations-26.0.2.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "org/jetbrains/annotations/NotNull");

  assert.equal(version, "unknown");
  assert.notEqual(version, "26.0.2", "the library's own release number is not a Minecraft version");
});

test("MinecraftExplorerService still reports a Minecraft version for a Minecraft jar staged inside a dependency store", async () => {
  // The safety control for the two tests above. Loom stages Minecraft into
  // maven-shaped local stores and Gradle caches what it resolves from them, so
  // both of these paths are real vanilla layouts sitting inside a dependency
  // store. Refusing them would blank out a version the tool genuinely knows.
  const root = await mkdtemp(join(tmpdir(), "explorer-minecraft-in-store-"));

  const m2Version = await signatureVersionForJarPath(
    root,
    join(root, ".m2", "repository", "net", "minecraft", "client", "1.21.10", "client-1.21.10.jar"),
    "net/minecraft/client/Minecraft"
  );
  assert.equal(m2Version, "1.21.10");

  const loomVersion = await signatureVersionForJarPath(
    root,
    join(
      root,
      "caches",
      "modules-2",
      "files-2.1",
      "net.minecraft",
      "minecraft-merged",
      "1.21.10",
      "0123456789abcdef",
      "minecraft-merged-1.21.10.jar"
    ),
    "net/minecraft/world/item/Item"
  );
  assert.equal(
    loomVersion,
    "1.21.10",
    "a Loom-staged Minecraft jar reports its own version, not the cache layout's \"2.1\""
  );
});

test("MinecraftExplorerService reports unknown minecraftVersion for a net.minecraft library named directly out of a local Maven repository", async () => {
  // Mojang publishes ordinary libraries under Minecraft's own group, and
  // `net.minecraft:launchwrapper:1.12` is the standing example. The group
  // directory alone therefore cannot rescue a store path from the refusal: read
  // that way, the library's own release number is served as a Minecraft version.
  const root = await mkdtemp(join(tmpdir(), "explorer-m2-mc-group-library-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "net",
    "minecraft",
    "launchwrapper",
    "1.12",
    "launchwrapper-1.12.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "net/minecraft/launchwrapper/Launch");

  assert.equal(version, "unknown");
  assert.notEqual(version, "1.12", "the library's own release number is not a Minecraft version");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a net.minecraft library named directly out of the Gradle dependency cache", async () => {
  // The same library as above in the other store layout, where the group is one
  // dotted directory rather than nested ones.
  const root = await mkdtemp(join(tmpdir(), "explorer-gradle-mc-group-library-"));
  const jarPath = join(
    root,
    "caches",
    "modules-2",
    "files-2.1",
    "net.minecraft",
    "launchwrapper",
    "1.12",
    "0123456789abcdef",
    "launchwrapper-1.12.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "net/minecraft/launchwrapper/Launch");

  assert.equal(version, "unknown");
  assert.notEqual(version, "1.12", "the library's own release number is not a Minecraft version");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a net.minecraft library in a store nested under a Minecraft-named directory", async () => {
  // Directories ABOVE the store root are the user's own layout and say nothing
  // about the jar the store serves. Judged over the whole path, a checkout named
  // `minecraft-client` vouched for `net.minecraft:launchwrapper` and the
  // library's own release number came back as a Minecraft version.
  const root = await mkdtemp(join(tmpdir(), "explorer-minecraft-client-project-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "net",
    "minecraft",
    "launchwrapper",
    "1.12",
    "launchwrapper-1.12.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "net/minecraft/launchwrapper/Launch");

  assert.equal(version, "unknown");
  assert.notEqual(version, "1.12", "an ancestor directory's name cannot vouch for a jar a store serves");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a store jar whose group merely ends in net.minecraft", async () => {
  // `com.acme.net.minecraft:client` is a third-party coordinate that happens to
  // end in Minecraft's group. Its `net/minecraft` directories sit below
  // `com/acme/`, not where a store layout puts a group, so nothing here names
  // the runtime; read as Minecraft's group they served the library's release.
  const root = await mkdtemp(join(tmpdir(), "explorer-m2-nested-group-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "com",
    "acme",
    "net",
    "minecraft",
    "client",
    "9.9",
    "acme-9.9.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "com/acme/client/AcmeClient");

  assert.equal(version, "unknown");
  assert.notEqual(version, "9.9", "the library's own release number is not a Minecraft version");
});

// A local Maven repository's root directory name is configurable, so the group read
// must recognise the root by its position, not by the default name `repository`.
// Pinned to that literal, a Minecraft jar under `~/.m2/repo` fell through to the
// name-only fallback and lost its version — a conservative miss, but still a real
// version the tool knew and stopped reporting.
test("MinecraftExplorerService reports a Minecraft version from a local Maven repository with a non-default root name", async () => {
  const root = await mkdtemp(join(tmpdir(), "explorer-m2-alt-root-"));
  const jarPath = join(
    root,
    ".m2",
    "repo",
    "net",
    "minecraft",
    "client",
    "1.21.10",
    "client-1.21.10.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "net/minecraft/client/Minecraft");

  assert.equal(version, "1.21.10");
  assert.notEqual(version, "unknown", "the runtime artifact is still recognised under a renamed root");
});

test("MinecraftExplorerService still reports a Minecraft version for a vanilla jar under a version-numbered path", async () => {
  // The plain vanilla control: nothing about this path resembles a dependency
  // store, so the refusal must not reach it.
  const root = await mkdtemp(join(tmpdir(), "explorer-vanilla-path-"));
  const version = await signatureVersionForJarPath(
    root,
    join(root, "versions", "1.21.10", "1.21.10.jar"),
    "net/minecraft/client/Minecraft"
  );

  assert.equal(version, "1.21.10");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a dependency-origin jar outside any dependency store", async () => {
  // The dependencyOrigin flag and the path refusal cover different jars: this
  // one sits in a plain directory named after the library's own release, which
  // no path shape can distinguish from a Minecraft version. Only the caller's
  // knowledge that this is a dependency can suppress it.
  const root = await mkdtemp(join(tmpdir(), "explorer-dep-origin-flat-"));
  const jarPath = join(root, "libs", "fabric-gametest-api-v1", "4.0.21", "fabric-gametest-api-v1.jar");
  await mkdir(join(root, "libs", "fabric-gametest-api-v1", "4.0.21"), { recursive: true });
  const fqn = "net.fabricmc.fabric.api.gametest.v1.FabricGameTest";
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = createService(root);

  const unflagged = await service.getSignature({ jarPath, fqn });
  assert.equal(unflagged.context.minecraftVersion, "4.0.21");

  const flagged = await service.getSignature({ jarPath, fqn, dependencyOrigin: true });
  assert.equal(flagged.context.minecraftVersion, "unknown");
});
