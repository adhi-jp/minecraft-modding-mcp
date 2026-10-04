import assert from "node:assert/strict";
import { expectAppErrorCode } from "../helpers/expect-app-error.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, createError } from "../../src/errors.ts";
import { normalizePathForHost } from "../../src/path-converter.ts";
import { SourceService } from "../../src/source-service.ts";
import { resolveVersionContext } from "../../src/source/artifact-resolver.ts";
import { withEnv } from "../helpers/env.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/**
 * Regression (AGENTS.md: WSL/Windows path normalization is behaviour, not
 * cosmetics): `projectPath` reached `synthesizeWorkspaceTarget`,
 * `synthesizeDependencyTarget` and the three `preferProjectVersion` readers
 * raw, while every sibling route put it through `normalizeOptionalProjectPath`.
 * A Windows-spelled path on a WSL host therefore worked for
 * `target.kind="version"` and failed for `target.kind="workspace"` — the same
 * caller, the same project, two answers.
 */

const DISTRO = "u5-distro";
/** Forces `detectPathRuntime` down its WSL branch on any Linux host. */
const WSL_ENV = { WSL_DISTRO_NAME: DISTRO };
const LINUX_ONLY =
  process.platform === "linux" ? false : "UNC/WSL spellings only resolve on a Linux host";

/** The `\\wsl$\<distro>\...` spelling a Windows-side agent sends for a Linux path. */
function uncSpelling(posixPath: string): string {
  return `\\\\wsl$\\${DISTRO}\\${posixPath.replace(/^\//, "").replace(/\//g, "\\")}`;
}

/** The same path with the two separator styles mixed, as a spliced path arrives. */
function mixedSeparatorSpelling(posixPath: string): string {
  return `\\\\wsl$\\${DISTRO}\\${posixPath.replace(/^\//, "")}`;
}

type AnySourceService = SourceService & {
  synthesizeWorkspaceTarget: (
    input: Record<string, unknown>,
    workspace: Record<string, unknown>
  ) => Promise<{
    target: { kind: string; value: string };
    provenance: { projectPath: string; cacheHit: boolean };
  }>;
  synthesizeDependencyTarget: (
    input: Record<string, unknown>,
    dep: Record<string, unknown>
  ) => Promise<{ target: { kind: string; value: string } }>;
  probeMinecraftArtifact: (input: Record<string, unknown>) => Promise<unknown>;
  resolveArtifact: (input: Record<string, unknown>) => Promise<unknown>;
};

async function makeWorkspace(props: Record<string, string>): Promise<{
  root: string;
  projectPath: string;
  service: AnySourceService;
}> {
  const root = await mkdtemp(join(tmpdir(), "path-"));
  const lines = Object.entries(props).map(([key, value]) => `${key}=${value}`);
  await writeFile(join(root, "gradle.properties"), `${lines.join("\n")}\n`, "utf8");
  return {
    root,
    projectPath: root,
    service: new SourceService(buildTestConfig(root)) as unknown as AnySourceService
  };
}

/** A version service that only reports which version it was asked to resolve. */
function recordingVersionService(service: AnySourceService): void {
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      throw createError({
        code: ERROR_CODES.VERSION_NOT_FOUND,
        message: `asked:${version}`
      });
    }
  };
}

test("synthesizeWorkspaceTarget reads a Windows-spelled projectPath", { skip: LINUX_ONLY }, async () => {
  const { projectPath, service } = await makeWorkspace({ minecraft_version: "1.21.10" });

  await withEnv(WSL_ENV, async () => {
    const synthesized = await service.synthesizeWorkspaceTarget(
      { target: { kind: "workspace" }, projectPath: uncSpelling(projectPath) },
      { kind: "workspace" }
    );

    assert.deepEqual(synthesized.target, { kind: "version", value: "1.21.10" });
    assert.equal(synthesized.provenance.projectPath, projectPath);
  });
});

test("synthesizeWorkspaceTarget normalizes the boundary spellings", { skip: LINUX_ONLY }, async (t) => {
  const { projectPath, service } = await makeWorkspace({ minecraft_version: "1.21.10" });
  const unc = uncSpelling(projectPath);

  await withEnv(WSL_ENV, async () => {
    const cases: Array<{ name: string; spelling: string; expected: string }> = [
      // Mixed separators: a Windows-side caller often hands back a path it
      // spliced together from both styles.
      { name: "mixed separators", spelling: mixedSeparatorSpelling(projectPath), expected: projectPath },
      { name: "trailing separator", spelling: `${unc}\\`, expected: `${projectPath}/` },
      // An already-POSIX path must pass through untouched.
      { name: "already POSIX", spelling: projectPath, expected: projectPath }
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const synthesized = await service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace" }, projectPath: testCase.spelling },
          { kind: "workspace" }
        );
        assert.equal(synthesized.target.value, "1.21.10");
        assert.equal(synthesized.provenance.projectPath, testCase.expected);
      });
    }
  });
});

test("synthesizeWorkspaceTarget reports the normalized drive-letter path", { skip: LINUX_ONLY }, async () => {
  const { service } = await makeWorkspace({ other: "value" });

  await withEnv(WSL_ENV, async () => {
    await assert.rejects(
      () =>
        service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace" }, projectPath: "C:\\u5\\missing-project" },
          { kind: "workspace" }
        ),
      (error: Error & { code?: string; details?: Record<string, unknown> }) => {
        assert.equal(error.code, ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED);
        // Pre-fix the report echoed "C:\u5\missing-project", a path nothing on
        // this host could ever have read.
        assert.equal(error.details?.projectPath, "/mnt/c/u5/missing-project");
        return true;
      }
    );
  });
});

test("synthesizeWorkspaceTarget keeps one workspace-context entry per project", { skip: LINUX_ONLY }, async () => {
  const { projectPath, service } = await makeWorkspace({ minecraft_version: "1.21.10" });

  await withEnv(WSL_ENV, async () => {
    const first = await service.synthesizeWorkspaceTarget(
      { target: { kind: "workspace" }, projectPath },
      { kind: "workspace" }
    );
    assert.equal(first.provenance.cacheHit, false);

    // Two spellings of one project are one project, so the second call must hit
    // the cache the first one filled rather than detect the workspace again.
    const second = await service.synthesizeWorkspaceTarget(
      { target: { kind: "workspace" }, projectPath: uncSpelling(projectPath) },
      { kind: "workspace" }
    );
    assert.equal(second.provenance.cacheHit, true);
  });
});

test("synthesizeDependencyTarget reads a Windows-spelled projectPath", { skip: LINUX_ONLY }, async () => {
  const { projectPath, service } = await makeWorkspace({ fabric_api_version: "0.100.0" });

  await withEnv(WSL_ENV, async () => {
    const synthesized = await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: uncSpelling(projectPath) },
      { kind: "dependency", group: "net.fabricmc.fabric-api", name: "fabric-api" }
    );

    assert.deepEqual(synthesized.target, {
      kind: "coordinate",
      value: "net.fabricmc.fabric-api:fabric-api:0.100.0"
    });
  });
});

test("resolveVersionContext reads a Windows-spelled projectPath", { skip: LINUX_ONLY }, async () => {
  const { projectPath, service } = await makeWorkspace({ minecraft_version: "1.21.10" });
  const warnings: string[] = [];

  await withEnv(WSL_ENV, async () => {
    const version = await resolveVersionContext(service as unknown as SourceService, {
      projectPath: uncSpelling(projectPath),
      preferProjectVersion: true,
      warnings
    });

    assert.equal(version, "1.21.10");
    assert.equal(warnings.length, 1);
  });
});

test("preferProjectVersion reads a Windows-spelled projectPath on both resolve routes", { skip: LINUX_ONLY }, async (t) => {
  const routes: Array<{ name: string; run: (service: AnySourceService, spelling: string) => Promise<unknown> }> = [
    {
      name: "resolveArtifact",
      run: (service, spelling) =>
        service.resolveArtifact({
          target: { kind: "version", value: "1.0.0" },
          preferProjectVersion: true,
          projectPath: spelling
        })
    },
    {
      name: "probeMinecraftArtifact",
      run: (service, spelling) =>
        service.probeMinecraftArtifact({
          target: { kind: "version", value: "1.0.0" },
          preferProjectVersion: true,
          projectPath: spelling
        })
    }
  ];

  for (const route of routes) {
    await t.test(route.name, async () => {
      const { projectPath, service } = await makeWorkspace({ minecraft_version: "1.21.10" });
      recordingVersionService(service);

      await withEnv(WSL_ENV, async () => {
        await assert.rejects(
          () => route.run(service, uncSpelling(projectPath)),
          (error: Error & { message: string }) => {
            // Pre-fix the Windows spelling read as a missing directory, so the
            // project version was never detected and "1.0.0" went through.
            assert.equal(error.message, "asked:1.21.10");
            return true;
          }
        );
      });
    });
  }
});

test("a Windows-spelled projectPath stays refused on a non-WSL host", () => {
  // The helper's own rule, asserted where a runtime can be handed to it: on a
  // plain Linux host a drive path names nothing, and normalizing it into
  // /mnt/c/... would invent a location. `detectPathRuntime` reads os.release(),
  // so the call sites cannot be steered off the WSL branch from a test.
  assert.throws(
    () => normalizePathForHost("C:\\u5\\proj", { platform: "linux", isWsl: false }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, ERROR_CODES.INVALID_INPUT);
      assert.match(error.message, /Windows-style paths are not supported/);
      return true;
    }
  );
});

test("a malformed drive path is refused as invalid input, not read as a directory", { skip: LINUX_ONLY }, async () => {
  const { service } = await makeWorkspace({ minecraft_version: "1.21.10" });

  await withEnv(WSL_ENV, async () => {
    await assert.rejects(
      () =>
        service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace" }, projectPath: "C:no-separator\\proj" },
          { kind: "workspace" }
        ),
      expectAppErrorCode(ERROR_CODES.INVALID_INPUT)
    );
  });
});
