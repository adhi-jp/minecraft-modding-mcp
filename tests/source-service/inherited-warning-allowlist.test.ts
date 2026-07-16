import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

async function signatureWarningsFor(superInternalName: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "inherited-warnings-"));
  const jarPath = join(root, "classes.jar");
  await createJar(jarPath, {
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      superInternalName,
      methods: [{ name: "tick", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "com.example.Child",
    jarPath,
    includeInherited: true
  });
  return signature.warnings;
}

test("JDK super-class resolution failures are suppressed during inherited-member expansion", async () => {
  for (const superName of ["java/lang/Object", "javax/swing/JComponent", "jdk/internal/misc/Unsafe", "sun/misc/Launcher"]) {
    const warnings = await signatureWarningsFor(superName);
    const dotted = superName.replaceAll("/", ".");
    assert.ok(
      !warnings.some((warning) => warning.includes(dotted)),
      `expected no ${dotted} warning, got: ${JSON.stringify(warnings)}`
    );
  }
});

test("allowlisted interface resolution failures are suppressed during inherited-member expansion", async () => {
  const root = await mkdtemp(join(tmpdir(), "inherited-warnings-iface-"));
  const jarPath = join(root, "classes.jar");
  await createJar(jarPath, {
    "com/example/Child.class": buildClassFile({
      internalName: "com/example/Child",
      interfaceInternalNames: ["java/util/List", "net/minecraft/world/ContainerListener"],
      methods: [{ name: "tick", descriptor: "()V", accessFlags: 0x0001 }]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "com.example.Child",
    jarPath,
    includeInherited: true
  });

  assert.ok(
    !signature.warnings.some((warning) => warning.includes("java.util.List")),
    `expected no java.util.List warning, got: ${JSON.stringify(signature.warnings)}`
  );
  assert.ok(
    signature.warnings.some((warning) =>
      warning.includes('interface class "net.minecraft.world.ContainerListener"')
    ),
    `expected the Minecraft interface warning to stay visible, got: ${JSON.stringify(signature.warnings)}`
  );
});

test("verified-absent platform prefixes like com.mojang.serialization are suppressed", async () => {
  const warnings = await signatureWarningsFor("com/mojang/serialization/Codec");
  assert.ok(
    !warnings.some((warning) => warning.includes("com.mojang.serialization.Codec")),
    `expected no serialization warning, got: ${JSON.stringify(warnings)}`
  );
});

test("a missing real Minecraft super class keeps its warning visible", async () => {
  const warnings = await signatureWarningsFor("net/minecraft/world/entity/Entity");
  assert.ok(
    warnings.some((warning) =>
      warning.includes('Could not resolve super class "net.minecraft.world.entity.Entity"')
    ),
    `expected the Entity warning to stay visible, got: ${JSON.stringify(warnings)}`
  );
});

test("com.mojang.blaze3d stays outside the allowlist because it ships in the client jar", async () => {
  const warnings = await signatureWarningsFor("com/mojang/blaze3d/pipeline/RenderPipeline");
  assert.ok(
    warnings.some((warning) => warning.includes("com.mojang.blaze3d.pipeline.RenderPipeline")),
    `expected the blaze3d warning to stay visible, got: ${JSON.stringify(warnings)}`
  );
});
