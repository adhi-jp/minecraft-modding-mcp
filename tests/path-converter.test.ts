import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import {
  isUncWslPath,
  isWindowsDrivePath,
  isWslMountPath,
  normalizePathForHost
} from "../src/path-converter.ts";

const WSL_RUNTIME = {
  platform: "linux",
  isWsl: true,
  wslDistro: "Ubuntu"
} as const;

const WINDOWS_RUNTIME = {
  platform: "win32",
  isWsl: false,
  wslDistro: "Ubuntu"
} as const;

test("path converter detects windows, wsl mount, and unc path styles", () => {
  assert.equal(isWindowsDrivePath("C:\\Users\\adhi\\mod.jar"), true);
  assert.equal(isWslMountPath("/mnt/c/Users/adhi/mod.jar"), true);
  assert.equal(isUncWslPath("\\\\wsl$\\Ubuntu\\home\\adhi\\mod.jar"), true);
});

test("normalizePathForHost converts windows drive paths to WSL mount paths", () => {
  const normalized = normalizePathForHost("C:\\Users\\adhi\\mod.jar", WSL_RUNTIME);
  assert.equal(normalized, "/mnt/c/Users/adhi/mod.jar");
});

test("normalizePathForHost converts WSL mount paths to Windows drive paths", () => {
  const normalized = normalizePathForHost("/mnt/d/mods/mod.jar", WINDOWS_RUNTIME);
  assert.equal(normalized, "D:\\mods\\mod.jar");
});

test("normalizePathForHost converts UNC WSL paths to Linux paths under WSL", () => {
  const normalized = normalizePathForHost("\\\\wsl$\\Ubuntu\\home\\adhi\\mod.jar", WSL_RUNTIME);
  assert.equal(normalized, "/home/adhi/mod.jar");
});

test("normalizePathForHost rejects malformed windows drive paths", () => {
  assert.throws(
    () => normalizePathForHost("C:bad\\minecraft.jar", WSL_RUNTIME),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );
});
