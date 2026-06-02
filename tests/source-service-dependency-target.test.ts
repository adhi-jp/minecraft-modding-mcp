import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { SourceService } from "../src/source-service.ts";
import { createWorkspaceContextCache } from "../src/workspace-context-cache.ts";
import { buildTestConfig } from "./helpers/test-config.ts";

type AnySourceService = SourceService & {
  synthesizeDependencyTarget: (
    input: Record<string, unknown>,
    dep: Record<string, unknown>
  ) => Promise<unknown>;
  workspaceContextCache: ReturnType<typeof createWorkspaceContextCache>;
};

async function makeHost(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dep-target-host-"));
  await mkdir(join(root, "cache"), { recursive: true });
  return root;
}

test("synthesizeDependencyTarget resolves explicit version directly", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" } },
    { kind: "dependency", group: "dev.architectury", name: "architectury", version: "13.0.0" }
  )) as {
    target: { kind: string; value: string };
    provenance: { resolvedVersion: string; source: string; cacheHit: boolean };
  };

  assert.equal(synthesized.target.kind, "coordinate");
  assert.equal(synthesized.target.value, "dev.architectury:architectury:13.0.0");
  assert.equal(synthesized.provenance.resolvedVersion, "13.0.0");
  assert.equal(synthesized.provenance.source, "explicit");
});

test("synthesizeDependencyTarget reads architectury_version from gradle.properties", async () => {
  const project = await mkdtemp(join(tmpdir(), "dep-target-arch-"));
  await writeFile(join(project, "gradle.properties"), "architectury_version=13.0.0\n", "utf8");
  const host = await makeHost();
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" }, projectPath: project },
    { kind: "dependency", group: "dev.architectury", name: "architectury" }
  )) as {
    target: { value: string };
    provenance: { resolvedVersion: string; source: string };
  };

  assert.equal(synthesized.target.value, "dev.architectury:architectury:13.0.0");
  assert.match(synthesized.provenance.source, /architectury_version/);
});

test("synthesizeDependencyTarget refuses to pick when modules-2 has multiple cached versions", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-dep-"));
  const cacheDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "dev.architectury",
    "architectury"
  );
  await mkdir(cacheDir, { recursive: true });
  for (const v of ["12.4.0", "13.0.0"]) {
    await mkdir(join(cacheDir, v), { recursive: true });
  }

  const project = await mkdtemp(join(tmpdir(), "dep-target-modules2-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & { code?: string; details?: { ambiguous?: boolean; candidatesSeen?: string[] } }) => {
        assert.equal(err.code, ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED);
        assert.equal(err.details?.ambiguous, true);
        assert.ok(err.details?.candidatesSeen?.includes("13.0.0"));
        assert.ok(err.details?.candidatesSeen?.includes("12.4.0"));
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget throws ERR_DEPENDENCY_VERSION_UNRESOLVED when neither source has the dependency", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-empty-dep-"));
  const project = await mkdtemp(join(tmpdir(), "dep-target-unresolved-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & {
        code?: string;
        details?: {
          suggestedCall?: unknown;
          exampleCalls?: Array<{ params?: { target?: { version?: string } } }>;
        };
      }) => {
        assert.equal(err.code, ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED);
        // The placeholder version is a fill-in template, not an executable call.
        assert.equal(err.details?.suggestedCall, undefined);
        assert.equal(err.details?.exampleCalls?.[0]?.params?.target?.version, "<your-version>");
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget rejects unsafe explicit version tokens", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  for (const badVersion of ["../1.0", "1.0/etc", "1.0\\bad", "..", "1\\0bad"]) {
    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" } },
          { kind: "dependency", group: "g.example", name: "lib", version: badVersion }
        ),
      (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
        assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
        assert.equal(err.details?.fieldErrors?.[0]?.path, "target.version");
        return true;
      }
    );
  }
});

test("synthesizeDependencyTarget rejects path traversal characters in group/name", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  await assert.rejects(
    () =>
      service.synthesizeDependencyTarget(
        { target: { kind: "dependency" } },
        { kind: "dependency", group: "../etc", name: "passwd", version: "1.0.0" }
      ),
    (err: Error & { code?: string }) => err.code === ERROR_CODES.INVALID_INPUT
  );
});

test("synthesizeDependencyTarget rejects when versionFromProject=false and no version is given", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  await assert.rejects(
    () =>
      service.synthesizeDependencyTarget(
        { target: { kind: "dependency" } },
        {
          kind: "dependency",
          group: "dev.architectury",
          name: "architectury",
          versionFromProject: false
        }
      ),
    (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
      assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(err.details?.fieldErrors?.[0]?.path, "target.version");
      return true;
    }
  );
});

test("synthesizeDependencyTarget reuses WorkspaceContextCache on subsequent calls", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-cached-"));
  const cacheDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "g.example",
    "lib"
  );
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(cacheDir, "1.0.0"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "dep-target-cache-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const cache = createWorkspaceContextCache();
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: cache }
    ) as unknown as AnySourceService;

    const first = (await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: project },
      { kind: "dependency", group: "g.example", name: "lib" }
    )) as { provenance: { cacheHit: boolean } };
    const second = (await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: project },
      { kind: "dependency", group: "g.example", name: "lib" }
    )) as { provenance: { cacheHit: boolean } };

    assert.equal(first.provenance.cacheHit, false);
    assert.equal(second.provenance.cacheHit, true);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget rejects target.kind=dependency when DEPENDENCY_TARGET_OFF is set", async () => {
  process.env.DEPENDENCY_TARGET_OFF = "1";
  try {
    const sourceServiceModule = await import(
      `../src/source-service.ts?toggle=dep-${Date.now()}`
    );
    const host = await makeHost();
    const service = new sourceServiceModule.SourceService(buildTestConfig(host)) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" } },
          { kind: "dependency", group: "g", name: "n", version: "1.0.0" }
        ),
      (err: Error & { code?: string }) => err.code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    delete process.env.DEPENDENCY_TARGET_OFF;
  }
});

test("synthesizeDependencyTarget tries the four de-duplicated property keys", async () => {
  const project = await mkdtemp(join(tmpdir(), "dep-target-keys-"));
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-keys-"));
  await writeFile(join(project, "gradle.properties"), "# none\n", "utf8");
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & { details?: { attempts?: string[] } }) => {
        const props = (err.details?.attempts ?? []).filter((entry) => entry.startsWith("gradle.properties:"));
        assert.deepEqual(props, [
          "gradle.properties:architectury_version",
          "gradle.properties:architecturyVersion",
          "gradle.properties:architectury_architectury_version",
          "gradle.properties:architecturyArchitecturyVersion"
        ]);
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});
