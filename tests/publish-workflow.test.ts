import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readPublishWorkflow(): Promise<string> {
  return readFile(".github/workflows/publish.yml", "utf8");
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

test("package.json version is reflected in CHANGELOG and the [Unreleased] section is never empty-headed", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const versionHeader = new RegExp(`^##\\s+\\[${pkg.version.replace(/\./g, "\\.")}\\]`, "m");
  assert.match(changelog, versionHeader);

  // Locate the [Unreleased] section if present. If present, it must contain at
  // least one non-blank body line before the next `## [` header — guarding the
  // memory rule "delete [Unreleased] when no items remain".
  const unreleasedIdx = changelog.indexOf("## [Unreleased]");
  if (unreleasedIdx !== -1) {
    const sliceAfter = changelog.slice(unreleasedIdx + "## [Unreleased]".length);
    const nextSection = sliceAfter.search(/^##\s+\[/m);
    const body = nextSection === -1 ? sliceAfter : sliceAfter.slice(0, nextSection);
    const meaningful = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    assert.ok(
      meaningful.length > 0,
      "CHANGELOG `## [Unreleased]` must either contain entries or be removed entirely"
    );
  }
});

test("publish workflow keeps the explanatory comment about npm 11 OIDC workaround", async () => {
  const workflow = await readPublishWorkflow();
  // Document why the npm 11.x escape hatch exists so future maintainers do not
  // strip the workaround without context.
  assert.match(workflow, /OIDC support for scoped packages/i);
});
