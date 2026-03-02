import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeModJar } from "../src/mod-analyzer.ts";
import { createJar } from "./helpers/zip.ts";

// ---------------------------------------------------------------------------
// 1. Fabric mod detection
// ---------------------------------------------------------------------------

test("analyzeModJar detects Fabric mod with full metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-fabric-"));
  const jarPath = join(root, "fabric-example.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example-mod",
      name: "Example Mod",
      version: "1.0.0",
      description: "A test mod",
      entrypoints: {
        main: ["com.example.ExampleMod"],
        client: [{ value: "com.example.ExampleClient" }]
      },
      mixins: ["example.mixins.json", { config: "example-extra.mixins.json" }],
      accessWidener: "example.accesswidener",
      depends: { fabricloader: ">=0.14.0", minecraft: "~1.20" },
      recommends: { fabric: "*" },
      conflicts: { badmod: "*" }
    }),
    "com/example/ExampleMod.class": Buffer.alloc(4),
    "com/example/ExampleClient.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "fabric");
  assert.equal(result.modId, "example-mod");
  assert.equal(result.modName, "Example Mod");
  assert.equal(result.modVersion, "1.0.0");
  assert.equal(result.description, "A test mod");
  assert.deepEqual(result.entrypoints, {
    main: ["com.example.ExampleMod"],
    client: ["com.example.ExampleClient"]
  });
  assert.deepEqual(result.mixinConfigs, ["example.mixins.json", "example-extra.mixins.json"]);
  assert.equal(result.accessWidener, "example.accesswidener");
  assert.equal(result.classCount, 2);
  assert.equal(result.classes, undefined);

  // Dependencies
  assert.ok(result.dependencies);
  const depFabricloader = result.dependencies.find((d) => d.modId === "fabricloader");
  assert.equal(depFabricloader?.kind, "required");
  assert.equal(depFabricloader?.versionRange, ">=0.14.0");

  const depFabric = result.dependencies.find((d) => d.modId === "fabric");
  assert.equal(depFabric?.kind, "recommends");

  const depBadmod = result.dependencies.find((d) => d.modId === "badmod");
  assert.equal(depBadmod?.kind, "conflicts");
});

// ---------------------------------------------------------------------------
// 2. Quilt mod detection
// ---------------------------------------------------------------------------

test("analyzeModJar detects Quilt mod with metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-quilt-"));
  const jarPath = join(root, "quilt-example.jar");
  await createJar(jarPath, {
    "quilt.mod.json": JSON.stringify({
      schema_version: 1,
      quilt_loader: {
        id: "quilt-mod",
        version: "2.0.0",
        metadata: {
          name: "Quilt Mod",
          description: "A quilt test mod"
        },
        entrypoints: {
          init: ["com.example.QuiltInit"]
        },
        depends: [
          { id: "quilt_loader", versions: ">=0.19.0" },
          "minecraft"
        ]
      },
      mixin: ["quilt.mixins.json"],
      access_widener: "quilt.accesswidener"
    }),
    "com/example/QuiltInit.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "quilt");
  assert.equal(result.modId, "quilt-mod");
  assert.equal(result.modName, "Quilt Mod");
  assert.equal(result.modVersion, "2.0.0");
  assert.deepEqual(result.entrypoints, { init: ["com.example.QuiltInit"] });
  assert.deepEqual(result.mixinConfigs, ["quilt.mixins.json"]);
  assert.equal(result.accessWidener, "quilt.accesswidener");
  assert.equal(result.classCount, 1);

  assert.ok(result.dependencies);
  assert.equal(result.dependencies.length, 2);
  const loaderDep = result.dependencies.find((d) => d.modId === "quilt_loader");
  assert.equal(loaderDep?.kind, "required");
  assert.equal(loaderDep?.versionRange, ">=0.19.0");
  const mcDep = result.dependencies.find((d) => d.modId === "minecraft");
  assert.equal(mcDep?.kind, "required");
});

// ---------------------------------------------------------------------------
// 3. Forge mod detection (mods.toml)
// ---------------------------------------------------------------------------

test("analyzeModJar detects Forge mod from META-INF/mods.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-forge-"));
  const jarPath = join(root, "forge-example.jar");
  const modsToml = `
modLoader = "javafml"
loaderVersion = "[40,)"

[[mods]]
modId = "forgemod"
displayName = "Forge Mod"
version = "3.0.0"
description = "A forge mod"

[[dependencies.forgemod]]
modId = "forge"
mandatory = true
versionRange = "[40,)"

[[dependencies.forgemod]]
modId = "optionallib"
mandatory = false
versionRange = "[1.0,)"
`;
  await createJar(jarPath, {
    "META-INF/mods.toml": modsToml,
    "com/example/ForgeMod.class": Buffer.alloc(4),
    "com/example/util/Helper.class": Buffer.alloc(4),
    "com/example/util/Other.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "forge");
  assert.equal(result.modId, "forgemod");
  assert.equal(result.modName, "Forge Mod");
  assert.equal(result.modVersion, "3.0.0");
  assert.equal(result.classCount, 3);

  assert.ok(result.dependencies);
  const forgeDep = result.dependencies.find((d) => d.modId === "forge");
  assert.equal(forgeDep?.kind, "required");
  const optDep = result.dependencies.find((d) => d.modId === "optionallib");
  assert.equal(optDep?.kind, "optional");
});

// ---------------------------------------------------------------------------
// 4. NeoForge detection via neoforge.mods.toml
// ---------------------------------------------------------------------------

test("analyzeModJar detects NeoForge from META-INF/neoforge.mods.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-neoforge-"));
  const jarPath = join(root, "neoforge-example.jar");
  const toml = `
modLoader = "javafml"
loaderVersion = "[1,)"

[[mods]]
modId = "neomod"
displayName = "Neo Mod"
version = "1.0.0"
`;
  await createJar(jarPath, {
    "META-INF/neoforge.mods.toml": toml,
    "com/example/NeoMod.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "neoforge");
  assert.equal(result.modId, "neomod");
  assert.equal(result.modName, "Neo Mod");
  assert.equal(result.classCount, 1);
});

// ---------------------------------------------------------------------------
// 5. NeoForge detection via modLoader field in mods.toml
// ---------------------------------------------------------------------------

test("analyzeModJar detects NeoForge from modLoader=lowcodefml in mods.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-neoforge2-"));
  const jarPath = join(root, "neoforge2-example.jar");
  const toml = `
modLoader = "lowcodefml"
loaderVersion = "[1,)"

[[mods]]
modId = "neomod2"
version = "2.0.0"
`;
  await createJar(jarPath, {
    "META-INF/mods.toml": toml,
    "com/example/NeoMod2.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "neoforge");
  assert.equal(result.modId, "neomod2");
});

// ---------------------------------------------------------------------------
// 6. Legacy Forge detection (mcmod.info)
// ---------------------------------------------------------------------------

test("analyzeModJar detects Legacy Forge from mcmod.info", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-legacy-"));
  const jarPath = join(root, "legacy-forge.jar");
  await createJar(jarPath, {
    "mcmod.info": JSON.stringify([
      {
        modid: "legacymod",
        name: "Legacy Mod",
        version: "0.1",
        description: "An old forge mod"
      }
    ]),
    "com/example/LegacyMod.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "forge");
  assert.equal(result.modId, "legacymod");
  assert.equal(result.modName, "Legacy Mod");
  assert.equal(result.modVersion, "0.1");
  assert.equal(result.description, "An old forge mod");
  assert.equal(result.classCount, 1);
});

// ---------------------------------------------------------------------------
// 7. Unknown loader (no metadata files)
// ---------------------------------------------------------------------------

test("analyzeModJar returns unknown loader when no metadata present", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-unknown-"));
  const jarPath = join(root, "unknown.jar");
  await createJar(jarPath, {
    "com/example/Something.class": Buffer.alloc(4),
    "assets/textures/logo.png": Buffer.alloc(16)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "unknown");
  assert.equal(result.modId, undefined);
  assert.equal(result.classCount, 1);
  assert.equal((result as { jarKind?: string }).jarKind, "binary");
});

test("analyzeModJar marks source-only jars with jarKind=source", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-source-jar-"));
  const jarPath = join(root, "source-only.jar");
  await createJar(jarPath, {
    "com/example/OnlySource.java": [
      "package com.example;",
      "public class OnlySource {}"
    ].join("\n")
  });

  const result = await analyzeModJar(jarPath);
  assert.equal(result.classCount, 0);
  assert.equal((result as { jarKind?: string }).jarKind, "source");
});

test("analyzeModJar marks jars with both .class and .java entries as jarKind=mixed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-mixed-jar-"));
  const jarPath = join(root, "mixed.jar");
  await createJar(jarPath, {
    "com/example/Mixed.class": Buffer.alloc(4),
    "com/example/Mixed.java": [
      "package com.example;",
      "public class Mixed {}"
    ].join("\n")
  });

  const result = await analyzeModJar(jarPath);
  assert.equal(result.classCount, 1);
  assert.equal((result as { jarKind?: string }).jarKind, "mixed");
});

// ---------------------------------------------------------------------------
// 8. includeClasses=true returns class list
// ---------------------------------------------------------------------------

test("analyzeModJar includes class list when includeClasses=true", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-classes-"));
  const jarPath = join(root, "classes.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ id: "classmod" }),
    "com/example/A.class": Buffer.alloc(4),
    "com/example/B.class": Buffer.alloc(4),
    "assets/data.json": "{}",
    "com/example/C.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath, { includeClasses: true });

  assert.equal(result.classCount, 3);
  assert.ok(result.classes);
  assert.equal(result.classes.length, 3);
  assert.ok(result.classes.includes("com/example/A.class"));
  assert.ok(result.classes.includes("com/example/B.class"));
  assert.ok(result.classes.includes("com/example/C.class"));
  // Non-class files should not be included
  assert.ok(!result.classes.includes("assets/data.json"));
});

// ---------------------------------------------------------------------------
// 9. Graceful fallback for invalid JSON
// ---------------------------------------------------------------------------

test("analyzeModJar gracefully falls back on invalid fabric.mod.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-badjson-"));
  const jarPath = join(root, "badjson.jar");
  await createJar(jarPath, {
    "fabric.mod.json": "{ this is not valid json!!!",
    "com/example/Broken.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "fabric");
  assert.equal(result.modId, undefined);
  assert.equal(result.classCount, 1);
});

// ---------------------------------------------------------------------------
// 10. Priority: fabric > forge when both present
// ---------------------------------------------------------------------------

test("analyzeModJar prioritizes fabric.mod.json over META-INF/mods.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-priority-"));
  const jarPath = join(root, "priority.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ id: "fabric-wins" }),
    "META-INF/mods.toml": `
modLoader = "javafml"
[[mods]]
modId = "forge-loses"
`,
    "com/example/Mod.class": Buffer.alloc(4)
  });

  const result = await analyzeModJar(jarPath);

  assert.equal(result.loader, "fabric");
  assert.equal(result.modId, "fabric-wins");
});

// ---------------------------------------------------------------------------
// 11. Non-existent path throws AppError
// ---------------------------------------------------------------------------

test("analyzeModJar throws AppError for non-existent path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-missing-"));
  const missingJarPath = join(root, "does-not-exist-at-all.jar");

  await assert.rejects(
    () => analyzeModJar(missingJarPath),
    (error: Error) => {
      assert.equal(error.name, "AppError");
      assert.equal((error as { code: string }).code, "ERR_INVALID_INPUT");
      return true;
    }
  );
});

test("analyzeModJar throws AppError for invalid jar contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-invalid-jar-"));
  const jarPath = join(root, "invalid.jar");
  await writeFile(jarPath, "not a zip archive", "utf8");

  await assert.rejects(
    () => analyzeModJar(jarPath),
    (error: Error) => {
      assert.equal(error.name, "AppError");
      assert.equal((error as { code: string }).code, "ERR_SOURCE_NOT_FOUND");
      return true;
    }
  );
});
