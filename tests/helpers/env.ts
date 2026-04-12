/**
 * Temporarily override environment variables, restoring originals after the callback.
 * Set a value to `undefined` to delete the variable for the duration.
 *
 * NOTE: process.env is process-global — these helpers are NOT safe for concurrent
 * use across parallel test files that touch the same variables.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

/** Convenience wrapper: set GRADLE_USER_HOME for the duration of the callback. */
export async function withGradleUserHome<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withEnv({ GRADLE_USER_HOME: dir }, fn);
}
