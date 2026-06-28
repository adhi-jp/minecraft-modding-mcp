/**
 * Predicate factory for asserting AppError-shaped throws in `assert.throws`.
 *
 * Replaces the `typeof error === "object" && error !== null && "code" in error
 * && (error as { code: string }).code === ...` block duplicated across the NBT
 * test files. Optionally matches selected `details` fields (e.g. jsonPointer).
 */
export function expectAppErrorCode(
  code: string,
  details?: Record<string, unknown>
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return false;
    }
    const err = error as { code: string; details?: Record<string, unknown> };
    if (err.code !== code) {
      return false;
    }
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        if (err.details?.[key] !== value) {
          return false;
        }
      }
    }
    return true;
  };
}
