import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError } from "../errors.js";
import { collectNestedJars } from "../mod-analyzer.js";
import { isSecureJarEntryPath } from "../path-resolver.js";
import {
  listJarEntries,
  readJarEntryAsBuffer,
  readJarEntryAsUtf8
} from "../source-jar-reader.js";

/**
 * A jar with at most this many own `.class` entries can qualify as a
 * Jar-in-Jar shell. Real Fabric API umbrella jars carry zero to a handful of
 * marker classes while every API class lives in META-INF/jars.
 */
export const SHELL_JAR_MAX_OUTER_CLASSES = 8;

export const NESTED_JAR_CACHE_DIRNAME = "nested-jars";

export interface NestedJarMatch {
  entryName: string;
  extractedPath: string;
}

export interface NestedClassMatch {
  qualifiedName: string;
  filePath: string;
  line: number;
  symbolKind: "class";
}

// In-process cache of class listings per extracted nested jar, so repeated
// class lookups against the same shell never re-open its nested jars. The
// shell's own inventory is persisted with the artifact record; this cache is
// only the per-nested-jar class membership.
const classSetCache = new Map<string, Set<string>>();
const CLASS_SET_CACHE_MAX = 32;

function rememberClassSet(key: string, value: Set<string>): void {
  classSetCache.delete(key);
  classSetCache.set(key, value);
  while (classSetCache.size > CLASS_SET_CACHE_MAX) {
    const oldest = classSetCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    classSetCache.delete(oldest);
  }
}

async function loadNestedJarClassSet(args: {
  cacheDir: string;
  outerJarPath: string;
  outerSignature: string;
  entryName: string;
}): Promise<{ extractedPath: string; classSet: Set<string> } | undefined> {
  let extractedPath: string;
  try {
    extractedPath = await extractNestedJar(
      args.cacheDir,
      args.outerJarPath,
      args.outerSignature,
      args.entryName
    );
  } catch {
    return undefined;
  }

  let classSet = classSetCache.get(extractedPath);
  if (!classSet) {
    try {
      const entries = await listJarEntries(extractedPath);
      classSet = new Set(
        entries.filter((entry) => entry.endsWith(".class") && isSecureJarEntryPath(entry))
      );
    } catch {
      return undefined;
    }
    rememberClassSet(extractedPath, classSet);
  }
  return { extractedPath, classSet };
}

function nestedClassMatch(entry: string): NestedClassMatch | undefined {
  const internalName = entry.slice(0, -".class".length);
  if (internalName.startsWith("META-INF/versions/")) {
    return undefined;
  }
  const binarySimpleName = internalName.split("/").at(-1) ?? internalName;
  if (binarySimpleName === "module-info" || binarySimpleName === "package-info") {
    return undefined;
  }
  const innerSegments = binarySimpleName.split("$").slice(1);
  if (innerSegments.some((segment) => segment.length === 0 || /^\d/.test(segment))) {
    return undefined;
  }

  return {
    qualifiedName: internalName.replaceAll("/", ".").replaceAll("$", "."),
    filePath: `${internalName.split("$")[0]}.java`,
    line: 1,
    symbolKind: "class"
  };
}

/**
 * Finds exact class-name matches across a shell's nested bytecode inventory.
 * Results use the same binary-backed class representation as entry-tool search:
 * an inferred outer Java path, line 1, and the broad class symbol kind.
 */
export async function findNestedJarClasses(args: {
  cacheDir: string;
  outerJarPath: string;
  outerSignature: string;
  inventory: string[];
  className: string;
  limit: number;
}): Promise<NestedClassMatch[]> {
  const normalizedQuery = args.className.trim().replaceAll("/", ".").replaceAll("$", ".");
  const isQualified = normalizedQuery.includes(".");
  const matches = new Map<string, NestedClassMatch>();

  inventory: for (const entryName of args.inventory) {
    const loaded = await loadNestedJarClassSet({
      cacheDir: args.cacheDir,
      outerJarPath: args.outerJarPath,
      outerSignature: args.outerSignature,
      entryName
    });
    if (!loaded) {
      continue;
    }
    for (const classEntry of [...loaded.classSet].sort((left, right) => left.localeCompare(right))) {
      const match = nestedClassMatch(classEntry);
      if (!match) {
        continue;
      }
      const simpleName = match.qualifiedName.split(".").at(-1) ?? match.qualifiedName;
      if (
        (isQualified && match.qualifiedName !== normalizedQuery) ||
        (!isQualified && simpleName !== normalizedQuery)
      ) {
        continue;
      }
      matches.set(match.qualifiedName, match);
      if (isQualified || matches.size >= args.limit) {
        break inventory;
      }
    }
  }

  return [...matches.values()];
}

/**
 * Shell detection with both required signals: near-zero own classes AND
 * bundled nested jars (META-INF/jars scan or fabric.mod.json "jars"
 * declarations that really exist in the archive). Returns the inventory for
 * shells and undefined for every regular jar.
 */
export async function detectShellJarInventory(jarPath: string): Promise<string[] | undefined> {
  let entries: string[];
  try {
    entries = await listJarEntries(jarPath);
  } catch {
    return undefined;
  }

  let ownClassCount = 0;
  for (const entry of entries) {
    if (entry.endsWith(".class")) {
      ownClassCount += 1;
      if (ownClassCount > SHELL_JAR_MAX_OUTER_CLASSES) {
        return undefined;
      }
    }
  }

  let declared: string[] | undefined;
  if (entries.includes("fabric.mod.json")) {
    try {
      const parsed: unknown = JSON.parse(await readJarEntryAsUtf8(jarPath, "fabric.mod.json"));
      const jars = (parsed as { jars?: Array<{ file?: unknown }> } | null)?.jars;
      if (Array.isArray(jars)) {
        declared = jars
          .map((entry) => entry?.file)
          .filter((file): file is string => typeof file === "string");
      }
    } catch {
      // Unreadable metadata leaves only the META-INF/jars scan signal.
    }
  }

  const inventory = collectNestedJars(entries, declared);
  return inventory.length > 0 ? inventory : undefined;
}

/**
 * Content-addressed on-disk location of an extracted nested jar. The digest
 * covers the outer jar path, its signature, and the entry name, so the same
 * shell always maps to the same extracted file and re-resolution reuses it.
 */
export function nestedJarCachePath(
  cacheDir: string,
  outerJarPath: string,
  outerSignature: string,
  entryName: string
): string {
  const digest = createHash("sha256")
    .update(`${outerJarPath}|${outerSignature}|${entryName}`)
    .digest("hex");
  return join(cacheDir, NESTED_JAR_CACHE_DIRNAME, `${digest}.jar`);
}

/**
 * Extracts one nested jar to the content-addressed cache (no-op when already
 * present). Entry-name safety is enforced by readJarEntryAsBuffer, and the
 * on-disk name is the digest — never derived from the entry name — so a
 * hostile entry name cannot escape the cache directory.
 */
export async function extractNestedJar(
  cacheDir: string,
  outerJarPath: string,
  outerSignature: string,
  entryName: string
): Promise<string> {
  const finalPath = nestedJarCachePath(cacheDir, outerJarPath, outerSignature, entryName);
  try {
    await access(finalPath);
    return finalPath;
  } catch {
    // fall through to extraction
  }
  const bytes = await readJarEntryAsBuffer(outerJarPath, entryName);
  await mkdir(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  await writeFile(tempPath, bytes);
  try {
    await rename(tempPath, finalPath);
  } catch (renameError) {
    // A concurrent extraction of the same entry may have won the rename.
    // The content-addressed final file being present makes this call a
    // success; anything else is a real failure.
    try {
      await access(finalPath);
    } catch {
      throw renameError;
    }
    await rm(tempPath, { force: true });
  }
  return finalPath;
}

/**
 * Finds every nested jar of a shell that contains the class. Zero matches
 * means the class genuinely is not bundled; more than one means the caller
 * must return candidates instead of picking silently.
 *
 * The lookup is deliberately single-level: it inspects each nested jar's own
 * class list only. A nested jar that is itself a shell surfaces its content
 * when resolved directly as its own artifact.
 */
export async function findNestedJarsContainingClass(args: {
  cacheDir: string;
  outerJarPath: string;
  outerSignature: string;
  inventory: string[];
  internalName: string;
}): Promise<NestedJarMatch[]> {
  const classEntry = `${args.internalName}.class`;
  const qualifiedName = args.internalName.replaceAll("/", ".").replaceAll("$", ".");
  const matches: NestedJarMatch[] = [];
  for (const entryName of args.inventory) {
    const loaded = await loadNestedJarClassSet({
      cacheDir: args.cacheDir,
      outerJarPath: args.outerJarPath,
      outerSignature: args.outerSignature,
      entryName
    });
    const containsClass = loaded?.classSet.has(classEntry) || [...(loaded?.classSet ?? [])].some((entry) =>
      entry.endsWith(".class") &&
      entry.slice(0, -".class".length).replaceAll("/", ".").replaceAll("$", ".") === qualifiedName
    );
    if (loaded && containsClass) {
      matches.push({ entryName, extractedPath: loaded.extractedPath });
    }
  }
  return matches;
}

/**
 * Resolves the single nested jar containing a class. Zero matches returns
 * undefined (the caller keeps its not-found contract); several matches throw
 * candidates instead of picking one silently.
 */
export async function resolveUniqueNestedJarForClass(args: {
  cacheDir: string;
  outerJarPath: string;
  outerArtifactId: string;
  inventory: string[];
  className: string;
}): Promise<NestedJarMatch | undefined> {
  const internalName = args.className.replace(/\./g, "/");
  const matches = await findNestedJarsContainingClass({
    cacheDir: args.cacheDir,
    outerJarPath: args.outerJarPath,
    outerSignature: args.outerArtifactId,
    inventory: args.inventory,
    internalName
  });
  if (matches.length === 0) {
    return undefined;
  }
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single) {
    return single;
  }
  throw createError({
    code: ERROR_CODES.NESTED_JAR_AMBIGUOUS,
    message: `Class "${args.className}" exists in ${matches.length} nested jars bundled by this shell jar; refusing to pick one automatically.`,
    details: {
      className: args.className,
      shellArtifactId: args.outerArtifactId,
      nestedJarCandidates: matches.map((match) => match.entryName),
      nextAction:
        "Resolve the intended nested jar as its own artifact, then query the class against that artifactId.",
      ...buildSuggestedCall({
        tool: "resolve-artifact",
        params: undefined,
        examples: matches.map((match) => ({
          params: { target: { kind: "jar", value: match.extractedPath } },
          reason: `Query classes inside "${match.entryName}" directly.`
        }))
      })
    }
  });
}
