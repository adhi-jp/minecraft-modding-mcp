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
