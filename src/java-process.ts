import { spawn } from "node:child_process";

import { createError, ERROR_CODES } from "./errors.js";
import { normalizePathForHost } from "./path-converter.js";

const JAVA_CHECK_TIMEOUT_MS = 2_000;
const MAX_STDIO_SNAPSHOT = 6_240;

export interface JavaProcessOptions {
  jarPath: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxMemoryMb?: number;
  minMemoryMb?: number;
  normalizePathArgs?: boolean;
}

export interface JavaProcessResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

function limitStdio(text: string): string {
  if (text.length <= MAX_STDIO_SNAPSHOT) {
    return text;
  }
  return text.slice(-MAX_STDIO_SNAPSHOT);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isOptionArg(value: string): boolean {
  return value.startsWith("-");
}

function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (isOptionArg(arg)) {
      return arg;
    }
    if (isAbsolutePath(arg)) {
      return normalizePathForHost(arg);
    }
    return arg;
  });
}

export async function assertJavaAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("java", ["-version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        createError({
          code: ERROR_CODES.JAVA_UNAVAILABLE,
          message: "java was not available within timeout."
        })
      );
    }, JAVA_CHECK_TIMEOUT_MS);

    proc.once("error", () => {
      clearTimeout(timer);
      reject(
        createError({
          code: ERROR_CODES.JAVA_UNAVAILABLE,
          message: "java command is not available."
        })
      );
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(
          createError({
            code: ERROR_CODES.JAVA_UNAVAILABLE,
            message: "java -version failed."
          })
        );
        return;
      }
      resolve();
    });
  });
}

export function runJavaProcess(options: JavaProcessOptions): Promise<JavaProcessResult> {
  const {
    jarPath,
    args,
    cwd,
    timeoutMs = 120_000,
    maxMemoryMb,
    minMemoryMb,
    normalizePathArgs = false
  } = options;

  const jvmArgs: string[] = [];
  if (maxMemoryMb) {
    jvmArgs.push(`-Xmx${maxMemoryMb}m`);
  }
  if (minMemoryMb) {
    jvmArgs.push(`-Xms${minMemoryMb}m`);
  }

  const normalizedJar = normalizePathArgs ? normalizePathForHost(jarPath) : jarPath;
  const processedArgs = normalizePathArgs ? normalizeArgs(args) : args;

  const spawnArgs = [...jvmArgs, "-jar", normalizedJar, ...processedArgs];

  return new Promise((resolve, reject) => {
    const proc = spawn("java", spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {})
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        createError({
          code: ERROR_CODES.JAVA_PROCESS_FAILED,
          message: "Java process timed out.",
          details: {
            jarPath: normalizedJar,
            reason: "timeout",
            timeoutMs,
            stderrTail: limitStdio(stderr)
          }
        })
      );
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      stdout = limitStdio(stdout);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      stderr = limitStdio(stderr);
    });

    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(
        createError({
          code: ERROR_CODES.JAVA_PROCESS_FAILED,
          message: "Java process failed to start.",
          details: {
            jarPath: normalizedJar,
            error: error instanceof Error ? error.message : String(error)
          }
        })
      );
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdoutTail: limitStdio(stdout),
        stderrTail: limitStdio(stderr)
      });
    });
  });
}
