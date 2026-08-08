#!/usr/bin/env node
/**
 * Generic "no SDK-private patching" source check.
 *
 * Run with: node scripts/premigration/no-sdk-private-patching.mjs
 *
 * Scans every .ts/.mts/.cts file under src/ and FLAGS:
 *
 *  RULE A — type-cast member assignment (monkey-patching through a cast):
 *    an object cast via `as unknown as { ... }` or `as any` whose member is
 *    then ASSIGNED (reads/calls through casts are fine). This catches the
 *    current SDK-private `validateToolInput` patch and any relocation of the
 *    same trick onto any object.
 *
 *  RULE B — writes to SDK-private members: assignment to an
 *    underscore-prefixed member (`x._foo = ...`) or to a known SDK-private
 *    hook (`.validateToolInput = ...`) in any file that imports from
 *    `@modelcontextprotocol/*` (private-by-convention SDK surface).
 *
 *  RULE C — deep imports of SDK INTERNAL paths: import/require specifiers
 *    reaching into `node_modules/...` or `@modelcontextprotocol/<pkg>/dist/...`.
 *    Public subpath exports (e.g. `@modelcontextprotocol/sdk/server/mcp.js`,
 *    `.../types.js`) are fine for v1 and are NOT flagged.
 *
 * Exit status: non-zero when any finding exists (prints file:line + excerpt).
 * Pre-migration this check MUST FAIL by detecting the validateToolInput patch
 * at src/index.ts:227-231; post-Phase-1a it must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

function collectSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...collectSourceFiles(path));
    else if (/\.(ts|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

function excerpt(content, index, span = 160) {
  return content
    .slice(index, index + span)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" \\n ")
    .slice(0, 160);
}

const RULE_A = /\(\s*[A-Za-z_$][\w$.]*\s+as\s+(?:unknown\s+as\s+\{[\s\S]{0,2000}?\}|any)\s*\)\s*\.\s*((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*=(?![=>])/g;
const RULE_B = /\.\s*(_[A-Za-z_$][\w$]*|validateToolInput)\s*=(?![=>])/g;
const RULE_C = /(?:from\s+|require\(\s*)["']([^"']*(?:node_modules\/|@modelcontextprotocol\/[^"']*\/dist\/)[^"']*)["']/g;

const findings = [];
for (const file of collectSourceFiles(SRC_ROOT)) {
  const content = readFileSync(file, "utf8");
  const relPath = relative(REPO_ROOT, file);
  const importsSdk = /from\s+["']@modelcontextprotocol\//.test(content);

  for (const match of content.matchAll(RULE_A)) {
    findings.push({
      rule: "A:type-cast-member-assignment",
      file: relPath,
      line: lineOf(content, match.index),
      member: match[1].replace(/\s+/g, ""),
      excerpt: excerpt(content, match.index)
    });
  }

  if (importsSdk) {
    for (const match of content.matchAll(RULE_B)) {
      // Avoid double-reporting the assignments RULE A already flags at the
      // same position range? Both rules are reported: A proves the cast
      // mechanism, B proves the SDK-private member write.
      findings.push({
        rule: "B:sdk-private-member-write",
        file: relPath,
        line: lineOf(content, match.index),
        member: match[1],
        excerpt: excerpt(content, match.index)
      });
    }
  }

  for (const match of content.matchAll(RULE_C)) {
    findings.push({
      rule: "C:sdk-internal-deep-import",
      file: relPath,
      line: lineOf(content, match.index),
      specifier: match[1],
      excerpt: excerpt(content, match.index)
    });
  }
}

if (findings.length === 0) {
  console.log("SDK-private patching check PASSED: no SDK-private patching, private-member writes, or internal deep imports found under src/");
  process.exit(0);
}

console.error(`SDK-private patching check FAILED: ${findings.length} finding(s):`);
for (const finding of findings) {
  console.error(
    `  [${finding.rule}] ${finding.file}:${finding.line} ${finding.member ?? finding.specifier ?? ""}\n      ${finding.excerpt}`
  );
}
process.exit(1);
