import { readFileSync } from "node:fs";

/**
 * Canonical server identity — the single source of the {name, version}
 * Implementation this process advertises.
 *
 * Consumers:
 *  - src/index.ts constructs the McpServer from these values; the SDK stamps
 *    that Implementation verbatim as `_meta["io.modelcontextprotocol/serverInfo"]`
 *    on every modern result it produces (and it is the initialize/discover
 *    serverInfo).
 *  - src/synthetic-decorator.ts stamps the same identity onto modern-era
 *    supervisor-synthesized results.
 *
 * Equality between live SDK results and synthetic decoration is therefore by
 * construction; the live-SDK drift-guard test
 * (tests/stdio/stdio-supervisor-synthetic-drift.test.ts) proves it end-to-end.
 */
export type ServerIdentity = { name: string; version: string };

export const SERVER_NAME = "@adhisang/minecraft-modding-mcp";

export function getServerVersionFromPackageJson(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // ignore and fallback
  }
  return "0.3.0";
}

export const SERVER_VERSION = getServerVersionFromPackageJson();

/** Frozen canonical identity; consumers needing a mutable object must copy. */
export const SERVER_IDENTITY: Readonly<ServerIdentity> = Object.freeze({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

/** Fresh, mutation-safe copy of the canonical identity. */
export function serverIdentitySnapshot(): ServerIdentity {
  return { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version };
}
