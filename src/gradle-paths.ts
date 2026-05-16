import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { normalizePathForHost } from "./path-converter.js";

export function normalizeOptionalProjectPath(projectPath: string | undefined): string | undefined {
  if (!projectPath) {
    return undefined;
  }
  const trimmed = projectPath.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePathForHost(trimmed, undefined, "projectPath");
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

export function normalizeOptionalGradleUserHomePath(gradleUserHome: string | undefined): string | undefined {
  if (!gradleUserHome) {
    return undefined;
  }
  const trimmed = gradleUserHome.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePathForHost(trimmed, undefined, "gradleUserHome");
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

export function resolveGradleUserHomePath(gradleUserHome?: string): string {
  const explicit = normalizeOptionalGradleUserHomePath(gradleUserHome);
  if (explicit) {
    return explicit;
  }
  const configured = process.env.GRADLE_USER_HOME?.trim();
  if (!configured) {
    return resolvePath(homedir(), ".gradle");
  }
  const normalized = normalizePathForHost(configured, undefined, "GRADLE_USER_HOME");
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

export type GradleCacheSearchInput =
  | string
  | {
      projectPath?: string;
      gradleUserHome?: string;
    }
  | undefined;

function normalizeGradleCacheSearchInput(input: GradleCacheSearchInput): {
  projectPath?: string;
  gradleUserHome?: string;
} {
  if (typeof input === "string" || input === undefined) {
    return {
      projectPath: normalizeOptionalProjectPath(input)
    };
  }
  const gradleUserHome = normalizeOptionalGradleUserHomePath(input.gradleUserHome);
  return {
    projectPath: normalizeOptionalProjectPath(input.projectPath),
    gradleUserHome
  };
}

export function buildVersionSourceSearchRoots(input: GradleCacheSearchInput): string[] {
  const { projectPath, gradleUserHome } = normalizeGradleCacheSearchInput(input);
  const roots = new Set<string>();
  if (projectPath) {
    roots.add(resolvePath(projectPath, ".gradle", "loom-cache"));
    roots.add(resolvePath(projectPath, ".gradle-user", "caches", "fabric-loom"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "fabric-loom"));
    const projectParent = dirname(projectPath);
    roots.add(resolvePath(projectParent, ".gradle-user-home", "loom-cache"));
    roots.add(resolvePath(projectParent, ".gradle-user-home", "caches", "fabric-loom"));
  }
  const homeGradle = resolveGradleUserHomePath(gradleUserHome);
  roots.add(resolvePath(homeGradle, "loom-cache"));
  roots.add(resolvePath(homeGradle, "caches", "fabric-loom"));
  return [...roots];
}

export function buildLoaderRuntimeSearchRoots(input: GradleCacheSearchInput): string[] {
  const { projectPath, gradleUserHome } = normalizeGradleCacheSearchInput(input);
  const roots = new Set<string>();
  if (projectPath) {
    roots.add(resolvePath(projectPath, "build"));
    roots.add(resolvePath(projectPath, ".gradle"));
    roots.add(resolvePath(projectPath, ".gradle", "forge-userdev"));
    roots.add(resolvePath(projectPath, ".gradle", "neogradle"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "forge_gradle"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "neogradle"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "neoformruntime"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "moddev"));
  }
  const homeGradle = resolveGradleUserHomePath(gradleUserHome);
  roots.add(resolvePath(homeGradle, "caches", "forge_gradle"));
  roots.add(resolvePath(homeGradle, "caches", "neogradle"));
  roots.add(resolvePath(homeGradle, "caches", "neoformruntime"));
  roots.add(resolvePath(homeGradle, "caches", "moddev"));
  return [...roots];
}
