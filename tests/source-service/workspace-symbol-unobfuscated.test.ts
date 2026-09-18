import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AnalyzeSymbolService, analyzeSymbolSchema } from "../../src/entry-tools/analyze-symbol-service.ts";
import { createError, ERROR_CODES } from "../../src/errors.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

// Minecraft 26.1+ ships its runtime in Mojang names, so a Loom project for it declares
// no `mappings` line. task=workspace used to stop at "no mapping declaration" and
// report mapping_unavailable (analyze-symbol status "partial") for every symbol.

const ITEM = "net.minecraft.world.item.Item";
const USE_DESCRIPTOR = "(Lnet/minecraft/world/item/ItemStack;)Lnet/minecraft/world/InteractionResult;";
const NO_DECLARATION_WARNING = "No compile-time mapping declaration was detected in build.gradle(.kts) files.";

async function createLoomProject(
  t: TestContext,
  prefix: string,
  minecraftVersion: string,
  mappingsLine?: string
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "gradle.properties"), `minecraft_version=${minecraftVersion}\n`, "utf8");
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id \"fabric-loom\" version \"1.14-SNAPSHOT\"",
      "}",
      "",
      "dependencies {",
      `  minecraft "com.mojang:minecraft:${minecraftVersion}"`,
      ...(mappingsLine ? [`  ${mappingsLine}`] : []),
      "  modImplementation \"net.fabricmc:fabric-loader:0.17.0\"",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}

type RuntimeProbe = {
  jarRequests: string[];
  signatureRequests: string[];
};

const ITEM_CONSTRUCTOR_DESCRIPTOR = "(Lnet/minecraft/world/item/Item$Properties;)V";

function itemSignature(version: string) {
  return {
    constructors: [
      {
        ownerFqn: ITEM,
        name: "<init>",
        javaSignature: "public Item(net.minecraft.world.item.Item.Properties)",
        jvmDescriptor: ITEM_CONSTRUCTOR_DESCRIPTOR,
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ],
    fields: [
      {
        ownerFqn: ITEM,
        name: "MAX_STACK_SIZE",
        javaSignature: "public static final int MAX_STACK_SIZE",
        jvmDescriptor: "I",
        accessFlags: 0x0019,
        isSynthetic: false
      }
    ],
    methods: [
      {
        ownerFqn: ITEM,
        name: "use",
        javaSignature: "public net.minecraft.world.InteractionResult use(net.minecraft.world.item.ItemStack)",
        jvmDescriptor: USE_DESCRIPTOR,
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ],
    warnings: [],
    context: {
      minecraftVersion: version,
      mappingType: "mojang",
      mappingNamespace: "mojang",
      jarSignature: "hash",
      generatedAt: new Date().toISOString()
    }
  };
}

/**
 * SourceService with the real workspace detection, a runtime jar that holds only
 * net.minecraft.world.item.Item, and a mapping service that fails the test when the
 * identity path consults the (empty on 26.x) mapping graph.
 */
async function createService(
  root: string,
  options: { jarResolves?: boolean; signatureError?: (fqn: string) => unknown } = {}
) {
  const { SourceService } = await import("../../src/source-service.ts");
  const service = new SourceService(buildTestConfig(root));
  const probe: RuntimeProbe = { jarRequests: [], signatureRequests: [] };
  const jarPath = join(root, "client.jar");

  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      probe.jarRequests.push(version);
      if (options.jarResolves === false) {
        throw new Error("jar download unavailable");
      }
      return {
        version,
        jarPath,
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      probe.signatureRequests.push(input.fqn);
      assert.equal(input.jarPath, jarPath);
      const injected = options.signatureError?.(input.fqn);
      if (injected) {
        throw injected;
      }
      if (input.fqn === ITEM) {
        return itemSignature("26.2");
      }
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: `Class "${input.fqn}" was not found.`
      });
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    async getClassApiMatrix(): Promise<never> {
      assert.fail("getClassApiMatrix must not run for an unobfuscated workspace without a mappings declaration");
    },
    async findMapping(): Promise<never> {
      assert.fail("findMapping must not run for an unobfuscated workspace without a mappings declaration");
    },
    async resolveMethodMappingExact(): Promise<never> {
      assert.fail("resolveMethodMappingExact must not run for an unobfuscated workspace without a mappings declaration");
    }
  };

  return { service, probe };
}

function expectedUnobfuscatedWarning(version: string): string {
  return `Minecraft ${version} is unobfuscated; no mappings declaration is needed — symbols are resolved against runtime (Mojang) names.`;
}

test("resolveWorkspaceSymbol resolves a Minecraft class by identity on an unobfuscated workspace without a mappings line", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-class-", "26.2");
  const { service, probe } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: "net/minecraft/world/item/Item",
    sourceMapping: "obfuscated"
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.resolved, true);
  assert.equal(result.resolvedSymbol?.name, ITEM);
  assert.equal(result.candidateCount, 1);
  assert.deepEqual(probe.signatureRequests, [ITEM]);
  // The requested/defaulted "obfuscated" label is kept; the compile
  // namespace the workspace uses is reported as the target.
  assert.equal(result.mappingContext.sourceMapping, "obfuscated");
  assert.equal(result.mappingContext.targetMapping, "mojang");
  assert.equal(result.mappingContext.unobfuscatedRuntime, true);
  assert.equal(result.mappingContext.runtimeValidated, true);
  assert.equal(result.workspaceDetection.resolved, true);
  assert.equal(result.workspaceDetection.mappingApplied, "mojang");
  assert.deepEqual(result.workspaceDetection.evidence, []);
  assert.deepEqual(result.workspaceDetection.warnings, [expectedUnobfuscatedWarning("26.2")]);
  assert.ok(result.warnings.includes(expectedUnobfuscatedWarning("26.2")));
  assert.ok(!result.warnings.includes(NO_DECLARATION_WARNING));
});

test("resolveWorkspaceSymbol reports a class missing from the unobfuscated runtime jar as not_found with a reason", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-glfw-", "26.2");
  const { service } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: "org.lwjgl.glfw.GLFW",
    sourceMapping: "obfuscated"
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.resolved, false);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.mappingContext.unobfuscatedRuntime, true);
  assert.ok(
    result.warnings.some(
      (warning) => warning.includes("org.lwjgl.glfw.GLFW") && warning.includes("was not found in the Minecraft 26.2 runtime jar")
    ),
    `expected a runtime-jar reason, got ${JSON.stringify(result.warnings)}`
  );
});

test("resolveWorkspaceSymbol checks fields and exact method descriptors by identity on an unobfuscated workspace", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-members-", "26.2");
  const { service } = await createService(root);

  const field = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "field",
    owner: "net/minecraft/world/item/Item",
    name: "MAX_STACK_SIZE",
    sourceMapping: "mojang"
  });
  assert.equal(field.status, "resolved");
  assert.equal(field.resolvedSymbol?.owner, ITEM);
  assert.equal(field.mappingContext.sourceMapping, "mojang");

  const method = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "method",
    owner: ITEM,
    name: "use",
    descriptor: USE_DESCRIPTOR,
    sourceMapping: "obfuscated"
  });
  assert.equal(method.status, "resolved");
  assert.equal(method.resolvedSymbol?.descriptor, USE_DESCRIPTOR);

  const wrongDescriptor = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "method",
    owner: ITEM,
    name: "use",
    descriptor: "()V",
    sourceMapping: "obfuscated"
  });
  assert.equal(wrongDescriptor.status, "not_found");
});

test("resolveWorkspaceSymbol keeps mapping_unavailable on an unobfuscated workspace when the runtime jar cannot be resolved", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-nojar-", "26.2");
  const { service, probe } = await createService(root, { jarResolves: false });

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: ITEM,
    sourceMapping: "obfuscated"
  });

  // Mirrors checkSymbolExists: an unverifiable symbol is not reported as missing.
  assert.equal(result.status, "mapping_unavailable");
  assert.deepEqual(probe.jarRequests, ["26.2"]);
  assert.ok(result.warnings.some((warning) => warning.includes("runtime jar could not be resolved")));
});

test("resolveWorkspaceSymbol does not translate intermediary or yarn names on an unobfuscated workspace", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-yarn-", "26.2");
  const { service, probe } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: ITEM,
    sourceMapping: "yarn"
  });

  assert.equal(result.status, "mapping_unavailable");
  assert.equal(result.mappingContext.sourceMapping, "yarn");
  assert.deepEqual(probe.signatureRequests, []);
  assert.ok(result.warnings.some((warning) => warning.includes("sourceMapping \"yarn\"") && warning.includes("mojang")));
});

test("resolveWorkspaceSymbol keeps the declared-mappings path on an unobfuscated workspace that has a mappings line", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-declared-", "26.2", "mappings loom.officialMojangMappings()");
  const { service, probe } = await createService(root);
  const matrixCalls: Array<Record<string, unknown>> = [];
  (service as unknown as { mappingService: unknown }).mappingService = {
    async getClassApiMatrix(input: Record<string, unknown>) {
      matrixCalls.push(input);
      return {
        version: "26.2",
        className: ITEM,
        classNameMapping: "obfuscated",
        classIdentity: { mojang: ITEM },
        rows: [],
        rowCount: 0,
        warnings: []
      };
    }
  };

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: ITEM,
    sourceMapping: "obfuscated"
  });

  assert.equal(matrixCalls.length, 1);
  assert.deepEqual(probe.signatureRequests, [], "declared mappings must not take the runtime identity path");
  assert.equal(result.status, "resolved");
  assert.equal(result.workspaceDetection.evidence.length, 1);
  assert.equal(result.workspaceDetection.evidence[0]?.reason, "officialMojangMappings()");
  assert.equal(result.mappingContext.unobfuscatedRuntime, undefined);
});

test("resolveWorkspaceSymbol keeps mapping_unavailable on a legacy workspace without a mappings line", async (t) => {
  const root = await createLoomProject(t, "ws-legacy-nomappings-", "1.21.10");
  const { service, probe } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "1.21.10",
    kind: "class",
    name: ITEM,
    sourceMapping: "obfuscated"
  });

  assert.equal(result.status, "mapping_unavailable");
  assert.equal(result.workspaceDetection.resolved, false);
  assert.deepEqual(result.workspaceDetection.warnings, [NO_DECLARATION_WARNING]);
  assert.deepEqual(result.warnings, [NO_DECLARATION_WARNING]);
  assert.equal(result.mappingContext.targetMapping, undefined);
  assert.deepEqual(probe.jarRequests, []);
  assert.deepEqual(probe.signatureRequests, []);
});

test("analyze-symbol task=workspace on an inferred 26.2 workspace without a mappings line is not partial", async (t) => {
  const { service } = await createService(await createLoomProject(t, "ws-unobf-analyze-scratch-", "26.2"));
  const unused = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  const analyze = new AnalyzeSymbolService({
    detectProjectMinecraftVersion: (projectPath: string) =>
      service.workspaceMappingService.detectProjectMinecraftVersion(projectPath),
    checkSymbolExists: unused("checkSymbolExists"),
    findMapping: unused("findMapping"),
    resolveMethodMappingExact: unused("resolveMethodMappingExact"),
    traceSymbolLifecycle: unused("traceSymbolLifecycle"),
    resolveWorkspaceSymbol: (input: Parameters<typeof service.resolveWorkspaceSymbol>[0]) =>
      service.resolveWorkspaceSymbol(input),
    getClassApiMatrix: unused("getClassApiMatrix")
  } as never);

  const run = async (projectPath: string, name: string) =>
    (await analyze.execute(
      analyzeSymbolSchema.parse({ task: "workspace", projectPath, subject: { kind: "class", name } })
    )) as { summary: { status: string }; warnings?: string[] };

  const unobfuscated = await createLoomProject(t, "ws-unobf-analyze-", "26.2");
  const item = await run(unobfuscated, ITEM);
  assert.equal(item.summary.status, "ok");
  assert.ok(item.warnings?.includes(expectedUnobfuscatedWarning("26.2")));
  assert.ok(!item.warnings?.includes(NO_DECLARATION_WARNING));

  const glfw = await run(unobfuscated, "org.lwjgl.glfw.GLFW");
  assert.equal(glfw.summary.status, "not_found");

  const legacy = await createLoomProject(t, "ws-legacy-analyze-", "1.21.10");
  const legacyResult = await run(legacy, ITEM);
  assert.equal(legacyResult.summary.status, "partial");
});

const NOT_VERIFIED_WARNING = /runtime bytecode lookup could not load class "net\.minecraft\.world\.item\.Item"/;

test("resolveWorkspaceSymbol reports a short class name it could not check as mapping_unavailable, not not_found", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-short-name-", "26.2");
  const { service, probe } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "class",
    name: "Item",
    sourceMapping: "obfuscated"
  });

  assert.equal(result.status, "mapping_unavailable");
  assert.equal(result.resolved, false);
  assert.deepEqual(probe.signatureRequests, [], "a short name never reaches the runtime jar");
  assert.equal(result.workspaceDetection.resolved, true);
  assert.ok(
    result.warnings.some((warning) => warning.includes('short class name "Item" could not be checked')),
    `expected the short-name reason, got ${JSON.stringify(result.warnings)}`
  );
});

test("resolveWorkspaceSymbol reports a runtime class it could not load as mapping_unavailable, not not_found", async (t) => {
  const failures: Array<[string, () => unknown]> = [
    ["EACCES", () => Object.assign(new Error("EACCES: permission denied, open 'client.jar'"), { code: "EACCES" })],
    ["ERR_INTERNAL", () => createError({ code: ERROR_CODES.INTERNAL, message: "Unsupported constant pool tag 99." })],
    ["ERR_JAR_NOT_FOUND", () => createError({ code: ERROR_CODES.JAR_NOT_FOUND, message: "Jar not found." })]
  ];
  for (const [label, failure] of failures) {
    const root = await createLoomProject(t, "ws-unobf-load-failure-", "26.2");
    const { service, probe } = await createService(root, { signatureError: failure });

    const classResult = await service.resolveWorkspaceSymbol({
      projectPath: root,
      version: "26.2",
      kind: "class",
      name: ITEM,
      sourceMapping: "obfuscated"
    });
    const methodResult = await service.resolveWorkspaceSymbol({
      projectPath: root,
      version: "26.2",
      kind: "method",
      owner: ITEM,
      name: "use",
      descriptor: USE_DESCRIPTOR,
      sourceMapping: "mojang"
    });

    assert.deepEqual(probe.signatureRequests, [ITEM, ITEM], `${label}: the runtime jar was asked`);
    for (const result of [classResult, methodResult]) {
      assert.equal(result.status, "mapping_unavailable", `${label}: an unverified lookup is not a definitive miss`);
      assert.equal(result.resolved, false);
      assert.ok(
        result.warnings.some((warning) => NOT_VERIFIED_WARNING.test(warning)),
        `${label}: expected the load-failure reason, got ${JSON.stringify(result.warnings)}`
      );
    }
  }
});

test("resolveWorkspaceSymbol keeps not_found for a member whose owner class is confirmed missing", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-missing-owner-", "26.2");
  const { service } = await createService(root);

  const result = await service.resolveWorkspaceSymbol({
    projectPath: root,
    version: "26.2",
    kind: "field",
    owner: "net.minecraft.world.item.Itemz",
    name: "MAX_STACK_SIZE",
    sourceMapping: "mojang"
  });

  assert.equal(result.status, "not_found");
  assert.ok(
    result.warnings.some((warning) => warning.includes("was not found in the Minecraft 26.2 runtime jar")),
    `expected the class-missing reason, got ${JSON.stringify(result.warnings)}`
  );
});

test("resolveWorkspaceSymbol checks a constructor query against the class's constructors", async (t) => {
  const root = await createLoomProject(t, "ws-unobf-constructor-", "26.2");
  const { service } = await createService(root);
  const constructorQuery = (descriptor: string) =>
    service.resolveWorkspaceSymbol({
      projectPath: root,
      version: "26.2",
      kind: "method",
      owner: ITEM,
      name: "<init>",
      descriptor,
      sourceMapping: "mojang"
    });

  const existing = await constructorQuery(ITEM_CONSTRUCTOR_DESCRIPTOR);
  assert.equal(existing.status, "resolved");
  assert.equal(existing.resolvedSymbol?.descriptor, ITEM_CONSTRUCTOR_DESCRIPTOR);

  const mismatched = await constructorQuery("()V");
  assert.equal(mismatched.status, "not_found");
});

test("resolveWorkspaceSymbol keeps mapping_unavailable for a 26.x version when the project path holds no build script", async (t) => {
  // No build.gradle(.kts) means nothing was scanned, so the absence of a mappings line
  // proves nothing: a typo'd or empty projectPath must not be read as a 26.x Loom project.
  const scratch = await mkdtemp(join(tmpdir(), "ws-unobf-nobuild-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const emptyProject = join(scratch, "empty");
  await mkdir(emptyProject);
  const missingProject = join(scratch, "does-not-exist");

  for (const projectPath of [missingProject, emptyProject]) {
    const { service, probe } = await createService(scratch);

    const result = await service.resolveWorkspaceSymbol({
      projectPath,
      version: "26.2",
      kind: "class",
      name: ITEM,
      sourceMapping: "obfuscated"
    });

    assert.equal(result.status, "mapping_unavailable", projectPath);
    assert.equal(result.resolved, false);
    assert.deepEqual(result.workspaceDetection, {
      resolved: false,
      evidence: [],
      warnings: [NO_DECLARATION_WARNING]
    });
    assert.deepEqual(result.warnings, [NO_DECLARATION_WARNING]);
    assert.equal(result.mappingContext.targetMapping, undefined);
    assert.equal(result.mappingContext.unobfuscatedRuntime, undefined);
    assert.deepEqual(probe.jarRequests, [], `${projectPath}: the runtime jar is never consulted`);
    assert.deepEqual(probe.signatureRequests, []);
  }
});
