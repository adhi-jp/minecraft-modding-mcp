import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a temporary directory, run the callback, then clean up.
 * Set `KEEP_TEST_TMP=1` to skip cleanup (useful for debugging failures).
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    if (!process.env.KEEP_TEST_TMP) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
