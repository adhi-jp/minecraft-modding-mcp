import { mock } from "node:test";

import { javaRunner } from "../../src/java-process.ts";
import type { JavaProcessOptions, JavaProcessResult } from "../../src/java-process.ts";

export type MockRunImpl = (options: JavaProcessOptions) => Promise<JavaProcessResult>;
export type MockAssertAvailableImpl = () => Promise<void>;

export interface RunRecording {
  calls: JavaProcessOptions[];
}

/**
 * Stubs `javaRunner.run` for the lifetime of a single test. The returned
 * recording captures every call's options so callers can assert on CLI args /
 * jarPath etc. The mock is automatically restored when the test ends because
 * `mock.method` is registered with node:test's automock restore tracking.
 */
export function mockJavaRunnerRun(impl: MockRunImpl): RunRecording {
  const recording: RunRecording = { calls: [] };
  mock.method(javaRunner, "run", async (options: JavaProcessOptions) => {
    recording.calls.push(options);
    return impl(options);
  });
  return recording;
}

/** Stubs `javaRunner.assertAvailable`. Defaults to resolving with no work. */
export function mockJavaRunnerAssertAvailable(
  impl: MockAssertAvailableImpl = async () => undefined
): void {
  mock.method(javaRunner, "assertAvailable", impl);
}

/** Combined helper: stub both endpoints and return the run recording. */
export function mockJavaRunner(
  runImpl: MockRunImpl,
  assertImpl?: MockAssertAvailableImpl
): RunRecording {
  mockJavaRunnerAssertAvailable(assertImpl);
  return mockJavaRunnerRun(runImpl);
}
