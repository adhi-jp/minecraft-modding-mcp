import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { WorkspaceMappingService } from "../../src/workspace-mapping-service.ts";
import { withEnv } from "../helpers/env.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * The Gradle-cache lookups in source-resolver and workspace-mapping-service read
 * `GRADLE_USER_HOME` through `resolveGradleUserHomePath`, so a Windows/UNC-spelled
 * value on a WSL host reaches the same cache as every other route.
 */

const DISTRO = "gradle-home-distro";
const WSL_ENV = { WSL_DISTRO_NAME: DISTRO };
const LINUX_ONLY =
  process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host";

/** The `\\wsl$\<distro>\...` spelling a Windows-side agent sends for a Linux path. */
function uncSpelling(posixPath: string): string {
  return `\\\\wsl$\\${DISTRO}\\${posixPath.replace(/^\//, "").replace(/\//g, "\\")}`;
}

test(
  "resolveSourceTarget(targetKind=coordinate) reads a Windows-spelled GRADLE_USER_HOME under WSL",
  { skip: LINUX_ONLY },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gradle-home-source-resolver-"));
    const gradleUserHome = join(root, "gradle-home");
    const sourceJarPath = join(
      gradleUserHome,
      "caches",
      "modules-2",
      "files-2.1",
      "dev.architectury",
      "architectury",
      "18.0.6",
      "sources-hash",
      "architectury-18.0.6-sources.jar"
    );
    const binaryJarPath = join(
      gradleUserHome,
      "caches",
      "modules-2",
      "files-2.1",
      "dev.architectury",
      "architectury",
      "18.0.6",
      "binary-hash",
      "architectury-18.0.6.jar"
    );

    await createJar(sourceJarPath, {
      "dev/architectury/platform/Platform.java": [
        "package dev.architectury.platform;",
        "public class Platform {}"
      ].join("\n")
    });
    await createJar(binaryJarPath, {
      "dev/architectury/platform/Platform.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    });

    await withEnv({ GRADLE_USER_HOME: uncSpelling(gradleUserHome), ...WSL_ENV }, async () => {
      const resolved = await resolveSourceTarget(
        { kind: "coordinate", value: "dev.architectury:architectury:18.0.6" },
        { allowDecompile: true },
        buildTestConfig(root)
      );

      assert.equal(resolved.origin, "local-m2");
      assert.equal(resolved.sourceJarPath, sourceJarPath);
      assert.equal(resolved.binaryJarPath, binaryJarPath);
    });
  }
);

test(
  "WorkspaceMappingService.detectDependencyVersion reads a Windows-spelled GRADLE_USER_HOME under WSL",
  { skip: LINUX_ONLY },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gradle-home-workspace-mapping-"));
    const gradleUserHome = join(root, "gradle-home");
    const projectPath = join(root, "workspace");
    const modulesDir = join(
      gradleUserHome,
      "caches",
      "modules-2",
      "files-2.1",
      "net.fabricmc.fabric-api",
      "fabric-api"
    );
    const versionDir = join(modulesDir, "0.100.0");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(versionDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });

    await withEnv({ GRADLE_USER_HOME: uncSpelling(gradleUserHome), ...WSL_ENV }, async () => {
      const service = new WorkspaceMappingService();
      const result = await service.detectDependencyVersion(
        projectPath,
        "net.fabricmc.fabric-api",
        "fabric-api"
      );

      assert.equal(result.resolved, true);
      if (result.resolved) {
        assert.equal(result.version, "0.100.0");
        assert.equal(result.source, `modules-2:${modulesDir}`);
      }
    });
  }
);
