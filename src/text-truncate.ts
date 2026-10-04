import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";

/**
 * Slice `text` to at most `maxChars` UTF-16 code units without splitting a
 * surrogate pair. A naive `text.slice(0, maxChars)` can leave a lone high
 * surrogate at the boundary (e.g. when an emoji straddles the cut), producing
 * an invalid string; this drops that dangling half so callers never emit one.
 */
export function sliceToMaxCharsSafe(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  let cut = text.slice(0, maxChars);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Writes `text` to the caller-supplied `outputFile` (resolved against the
 * working directory when relative) and returns the resolved path. A write
 * failure is reported as INVALID_INPUT carrying the OS error code.
 */
export async function writeSourceToOutputFile(outputFile: string, text: string): Promise<string> {
  const outputPath = isAbsolute(outputFile)
    ? outputFile
    : resolvePath(outputFile);
  try {
    await writeFile(outputPath, text, "utf8");
  } catch (writeError) {
    const errno = (writeError as NodeJS.ErrnoException | undefined)?.code;
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `outputFile "${outputPath}" could not be written (${errno ?? "unknown error"}).`,
      details: { field: "outputFile", value: outputPath, osErrorCode: errno }
    });
  }
  return outputPath;
}
