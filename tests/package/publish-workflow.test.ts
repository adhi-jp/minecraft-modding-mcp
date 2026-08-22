import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

async function readPublishWorkflow(): Promise<string> {
  return readFile(".github/workflows/publish.yml", "utf8");
}

/**
 * Lift one step's `run: |` block out of the real workflow, addressed by step name.
 *
 * The release-safety guarantees below live entirely in shell inside publish.yml, so
 * the assertions EXECUTE the committed snippet instead of restating its logic. A
 * hand-copied duplicate would keep passing after the workflow stopped enforcing the
 * rule, which is the exact failure these tests exist to prevent.
 */
function extractRunScript(workflow: string, stepName: string): string {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(stepIndex >= 0, `publish.yml must contain a step named "${stepName}"`);
  const stepIndent = lines[stepIndex].search(/\S/);

  let runIndex = -1;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    // A line indented no deeper than the `- ` marker has left this step.
    if (line.search(/\S/) <= stepIndent) break;
    if (/^run:\s*\|\s*$/.test(line.trim())) {
      runIndex = index;
      break;
    }
  }
  assert.ok(runIndex >= 0, `step "${stepName}" must carry a literal \`run: |\` block`);

  const body: string[] = [];
  let bodyIndent = -1;
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.search(/\S/);
    if (bodyIndent === -1) bodyIndent = indent;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  const script = body.join("\n").trimEnd();
  assert.ok(script.length > 0, `step "${stepName}" must have a non-empty run body`);
  return script;
}

/**
 * Run an extracted snippet the way the runner does: GitHub Actions executes a
 * `run:` block as `bash -e {0}`, so errexit is part of the contract under test.
 */
function runWorkflowStep(
  script: string,
  options: { cwd: string; env?: Record<string, string | undefined> }
): { status: number; stderr: string } {
  const scriptPath = join(options.cwd, "workflow-step.sh");
  writeFileSync(scriptPath, `${script}\n`, "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
  }
  // The snippets shell out to `node`; guarantee the interpreter running this suite
  // is the one they find.
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;

  const result = spawnSync("bash", ["-e", scriptPath], { cwd: options.cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `could not execute the extracted step: ${String(result.error)}`);
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function makeVersionFixture(version: string): string {
  const directory = mkdtempSync(join(tmpdir(), "publish-workflow-"));
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "publish-workflow-fixture", version, private: true }, null, 2)}\n`,
    "utf8"
  );
  return directory;
}

test("publish workflow publishes scoped package with explicit public access", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /registry-url:\s*"https:\/\/registry\.npmjs\.org"/);
  assert.match(workflow, /npm publish --no-git-checks --access public/);
});

test("publish workflow declares OIDC `id-token: write` and minimum `contents: read` permissions", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /permissions:\s*\n\s*id-token:\s*write/);
  assert.match(workflow, /contents:\s*read/);
});

test("publish workflow does not reference NPM_TOKEN (trusted publishing uses OIDC)", async () => {
  const workflow = await readPublishWorkflow();
  assert.ok(!/NPM_TOKEN/i.test(workflow), "publish.yml must not reference NPM_TOKEN");
});

test("publish workflow triggers only on `v*` tag pushes (no branch trigger)", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/);
  // Ensure no `branches:` key appears anywhere in the file. The `on:` section
  // is the only place that could legally introduce one in this workflow.
  assert.ok(
    !/^\s*branches:/m.test(workflow),
    "publish.yml must not include a `branches:` trigger anywhere"
  );
});

test("publish workflow pins Node 22, pnpm 10.30.1, and uses pnpm cache", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /version:\s*10\.30\.1/);
  assert.match(workflow, /cache:\s*pnpm/);
});

test("publish workflow uses npm 11.x for publish (OIDC for scoped packages)", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /npm exec --yes --package=npm@~11\.5\.\d+ -- npm publish/);
});

test("publish workflow runs install with --frozen-lockfile", async () => {
  const workflow = await readPublishWorkflow();
  assert.match(workflow, /pnpm install --frozen-lockfile/);
});

test("publish workflow runs install, check, test, build, then publish in that order", async () => {
  const workflow = await readPublishWorkflow();
  const idxInstall = workflow.indexOf("pnpm install");
  const idxCheck = workflow.indexOf("pnpm check");
  const idxTest = workflow.indexOf("pnpm test");
  const idxBuild = workflow.indexOf("pnpm build");
  const idxPublish = workflow.indexOf("npm publish");
  for (const [name, value] of Object.entries({
    install: idxInstall,
    check: idxCheck,
    test: idxTest,
    build: idxBuild,
    publish: idxPublish
  })) {
    assert.ok(value >= 0, `expected ${name} step in publish.yml`);
  }
  assert.ok(idxInstall < idxCheck && idxCheck < idxTest && idxTest < idxBuild && idxBuild < idxPublish,
    "expected order install → check → test → build → publish");
});

/**
 * The title says "[Unreleased] is omitted when empty"; the body no longer asserts that.
 *
 * The title predates the changelog policy now recorded in AGENTS.md under "Changelog and
 * Tag Safety": `## [Unreleased]` is a PERMANENT heading and is retained, empty, above each
 * newly cut release section, rather than being renamed into it. The title cannot be
 * corrected to match, because it belongs to the frozen named-test set
 * (`tests/fixtures/premigration/test-list.txt`) whose post-suite gate treats a rename as a
 * deletion and fails hard.
 *
 * What the body actually checks now:
 *   1. `package.json`'s version has a matching `## [X.Y.Z]` section, so a version cannot
 *      ship with no release notes. (Unchanged.)
 *   2. `## [Unreleased]` is present. This replaces the old "if it exists it must be
 *      non-empty" clause, which contradicted the adopted practice, and it catches the
 *      opposite mistake: a release cut that renames the heading away.
 */
test("package.json version is reflected in CHANGELOG and [Unreleased] is omitted when empty", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const versionHeader = new RegExp(`^##\\s+\\[${pkg.version.replace(/\./g, "\\.")}\\]`, "m");
  assert.match(changelog, versionHeader);

  assert.match(
    changelog,
    /^##\s+\[Unreleased\]\s*$/m,
    "CHANGELOG must keep the permanent `## [Unreleased]` heading above the newest release section"
  );
});

test("publish workflow resolves the `rc` dist-tag for a prerelease and `latest` for a stable version", async () => {
  const script = extractRunScript(await readPublishWorkflow(), "Resolve the npm dist-tag");
  const cases: Array<{ version: string; expected: string }> = [
    // The version this branch is about to tag.
    { version: "7.0.0-rc.0", expected: "rc" },
    { version: "7.0.0", expected: "latest" },
    // A version already published from this repository, so the stable arm is not
    // proven only against a number that has never existed.
    { version: "6.3.0", expected: "latest" }
  ];

  for (const { version, expected } of cases) {
    const directory = makeVersionFixture(version);
    try {
      const outputPath = join(directory, "github-output");
      writeFileSync(outputPath, "", "utf8");
      const run = runWorkflowStep(script, { cwd: directory, env: { GITHUB_OUTPUT: outputPath } });
      assert.equal(run.status, 0, `dist-tag resolution failed for ${version}: ${run.stderr}`);
      assert.equal(
        readFileSync(outputPath, "utf8").trim(),
        `tag=${expected}`,
        `version ${version} must publish under the "${expected}" dist-tag`
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("publish workflow tag guard rejects a tag that disagrees with package.json and accepts one that matches", async () => {
  const script = extractRunScript(
    await readPublishWorkflow(),
    "Verify the pushed tag matches the package version"
  );
  const cases: Array<{ version: string; ref: string; accepted: boolean }> = [
    { version: "7.0.0-rc.0", ref: "v7.0.0-rc.0", accepted: true },
    { version: "6.3.0", ref: "v6.3.0", accepted: true },
    // The dangerous direction: a stable tag pushed over a prerelease package version.
    { version: "7.0.0-rc.0", ref: "v7.0.0", accepted: false },
    { version: "7.0.0", ref: "v6.3.0", accepted: false }
  ];

  for (const { version, ref, accepted } of cases) {
    const directory = makeVersionFixture(version);
    try {
      const run = runWorkflowStep(script, { cwd: directory, env: { GITHUB_REF_NAME: ref } });
      if (accepted) {
        assert.equal(run.status, 0, `tag ${ref} must be accepted for version ${version}: ${run.stderr}`);
      } else {
        assert.notEqual(run.status, 0, `tag ${ref} must be rejected for version ${version}`);
        assert.match(
          run.stderr,
          /does not match package\.json version/,
          "a rejected tag must say which pair disagreed"
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("publish workflow rejects the frozen named-test set escape hatch at any value, including empty and 0", async () => {
  const script = extractRunScript(
    await readPublishWorkflow(),
    "Reject a bypass of the frozen named-test set gate"
  );
  const directory = mkdtempSync(join(tmpdir(), "publish-workflow-hatch-"));
  try {
    // Unset is the only accepted state.
    const unset = runWorkflowStep(script, {
      cwd: directory,
      env: { MCP_ALLOW_UNPROVEN_NAMED_TESTS: undefined }
    });
    assert.equal(unset.status, 0, `an unset escape hatch must not block a release: ${unset.stderr}`);

    // Presence is what is rejected, not truthiness: an empty value and "0" are both
    // exported variables, and either one would let a skipped inherited test ship.
    for (const value of ["1", "", "0", "false"]) {
      const run = runWorkflowStep(script, {
        cwd: directory,
        env: { MCP_ALLOW_UNPROVEN_NAMED_TESTS: value }
      });
      assert.notEqual(
        run.status,
        0,
        `MCP_ALLOW_UNPROVEN_NAMED_TESTS=${JSON.stringify(value)} must stop a release build`
      );
      assert.match(
        run.stderr,
        /must never be set for a release build/,
        "the rejection must name the variable it stopped on"
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publish workflow rejects the named-test gate bypass before it runs the suite", async () => {
  const workflow = await readPublishWorkflow();
  const rejectIndex = workflow.indexOf("- name: Reject a bypass of the frozen named-test set gate");
  const testIndex = workflow.indexOf("pnpm test");
  assert.ok(rejectIndex >= 0, "publish.yml must keep the escape-hatch rejection step");
  assert.ok(testIndex >= 0, "publish.yml must run the test suite");
  assert.ok(
    rejectIndex < testIndex,
    "the escape-hatch rejection must run before `pnpm test`, or the suite it guards has already run"
  );
});
