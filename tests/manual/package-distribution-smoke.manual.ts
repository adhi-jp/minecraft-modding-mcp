import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STARTUP_STABILITY_MS = 2_000;
const FORBIDDEN_PREFIXES = ["package/src/", "package/tests/", "package/.plans/", "package/.reference/", "package/.agents/"] as const;

type PackageJson = {
  name: string;
  version: string;
};

type PackManifestEntry = {
  filename: string;
};

async function runNpm(args: string[], npmCache: string): Promise<void> {
  await execFileAsync("npm", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCache
    }
  });
}

async function runNpmJson<T>(args: string[], npmCache: string): Promise<T> {
  const { stdout } = await execFileAsync("npm", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCache
    }
  });
  return JSON.parse(stdout) as T;
}

async function waitForStartupStability(child: ReturnType<typeof spawn>): Promise<void> {
  let output = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await delay(STARTUP_STABILITY_MS);
  if (child.exitCode !== null) {
    throw new Error(`CLI exited during startup window (code=${child.exitCode}).\nstdout:\n${output}\nstderr:\n${stderr}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "package-smoke-"));
  const npmCache = join(root, "npm-cache");
  const extractDir = join(root, "extract");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
  let tarballPath = "";

  try {
    await runNpm(["pack", "--dry-run"], npmCache);
    const packEntries = await runNpmJson<PackManifestEntry[]>(["pack", "--json"], npmCache);
    const tarballName = packEntries[0]?.filename;
    assert.ok(tarballName, `npm pack --json did not return a filename for ${packageJson.name}@${packageJson.version}.`);
    tarballPath = join(process.cwd(), tarballName);

    const { stdout: tarListRaw } = await execFileAsync("tar", ["-tf", tarballPath], {
      cwd: process.cwd()
    });
    const tarEntries = tarListRaw.split(/\r?\n/).filter((entry) => entry.trim().length > 0);
    const forbiddenEntries = tarEntries.filter((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix))
    );
    assert.deepEqual(
      forbiddenEntries,
      [],
      `Packaged tarball includes forbidden paths: ${forbiddenEntries.join(", ")}`
    );

    await mkdir(extractDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDir], {
      cwd: process.cwd()
    });

    const packageRoot = join(extractDir, "package");
    const cliPath = join(packageRoot, "dist", "cli.js");
    const packageNodeModules = join(packageRoot, "node_modules");
    const workspaceNodeModules = resolve("node_modules");

    await lstat(workspaceNodeModules);
    await symlink(workspaceNodeModules, packageNodeModules, "dir");

    const child = spawn("node", [cliPath], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "0",
        MCP_CACHE_DIR: join(root, "cache"),
        MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    await waitForStartupStability(child);
    child.kill("SIGTERM");
    await once(child, "exit");

    console.log("Package distribution smoke passed: tarball contents and CLI startup validated.");
  } finally {
    await unlink(tarballPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
