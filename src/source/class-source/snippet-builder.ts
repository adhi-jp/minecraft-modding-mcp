import * as classSourceHelpers from "../class-source-helpers.js";
import { sliceToMaxCharsSafe } from "../../text-truncate.js";
import type { SourceMode } from "../../source-service.js";

export type SnippetBuildInput = {
  filePath: string;
  content: string;
  mode: SourceMode;
  startLine: number | undefined;
  endLine: number | undefined;
  maxLines: number | undefined;
  maxChars: number | undefined;
};

export type SnippetBuildResult = {
  sourceText: string;
  totalLines: number;
  returnedStart: number;
  returnedEnd: number;
  truncated: boolean;
  charsTruncated: boolean;
  /**
   * First line the caller has NOT yet fully received, when more source remains.
   * Safe to pass back as `startLine` to continue reading. Undefined when the
   * response already reached the end of the file.
   */
  nextStartLine?: number;
  /**
   * True when the requested window begins past the end of the file. The returned
   * window is empty (returnedEnd < returnedStart) rather than clamped into the
   * last real line, so paginated readers can detect overshoot instead of silently
   * re-reading the final line.
   */
  outOfRange?: boolean;
};

export function buildClassSourceSnippet(input: SnippetBuildInput): SnippetBuildResult {
  const rawLines = input.content.split(/\r?\n/);
  // A trailing newline produces a final empty element that is not a real source
  // line. Drop a single one so totalLines and line addressing reflect the actual
  // source (decompiled Java almost always ends with a trailing newline).
  const lines =
    rawLines.length > 1 && rawLines[rawLines.length - 1] === ""
      ? rawLines.slice(0, -1)
      : rawLines;
  const totalLines = lines.length;

  let sourceText: string;
  let returnedStart: number;
  let returnedEnd: number;
  let truncated = false;
  let charsTruncated = false;

  if (input.mode === "metadata") {
    sourceText = classSourceHelpers.extractClassMetadata(input.filePath, input.content);
    returnedStart = 1;
    returnedEnd = totalLines;
  } else {
    const requestedStart = input.startLine ?? 1;
    const requestedEnd = input.endLine ?? totalLines;

    if (requestedStart > totalLines) {
      // The window begins past EOF: return an empty selection instead of clamping
      // into the last real line, so paginated readers can detect the overshoot.
      return {
        sourceText: "",
        totalLines,
        returnedStart: requestedStart,
        returnedEnd: requestedStart - 1,
        truncated: true,
        charsTruncated: false,
        outOfRange: true
      };
    }

    const normalizedStart = Math.max(1, requestedStart);
    const normalizedEnd = Math.min(Math.max(normalizedStart, requestedEnd), Math.max(totalLines, 1));
    let selectedLines = lines.slice(normalizedStart - 1, normalizedEnd);
    const clippedByRange = normalizedStart !== requestedStart || normalizedEnd !== requestedEnd;

    let clippedByMax = false;
    if (input.maxLines != null && selectedLines.length > input.maxLines) {
      selectedLines = selectedLines.slice(0, input.maxLines);
      clippedByMax = true;
    }

    sourceText = selectedLines.join("\n");
    returnedStart = normalizedStart;
    returnedEnd = normalizedStart + Math.max(0, selectedLines.length - 1);
    truncated = clippedByRange || clippedByMax;
  }

  if (input.maxChars != null && sourceText.length > input.maxChars) {
    sourceText = sliceToMaxCharsSafe(sourceText, input.maxChars);
    charsTruncated = true;
    truncated = true;
  }

  let nextStartLine: number | undefined;
  // Metadata mode returns a synthesized outline, not a line window into the
  // source, so its returnedStart/returnedEnd are not line-addressable and a
  // char cut must not yield a (bogus) line continuation.
  if (truncated && input.mode !== "metadata") {
    if (charsTruncated) {
      // A mid-line character cut may leave the final returned line partial.
      // Count only the complete (newline-terminated) lines and resume from the
      // first line not fully returned, re-reading any partial line in full.
      // Require forward progress: when the cut lands inside the first returned
      // line (no complete line returned), resuming at the same startLine with
      // the same maxChars would loop, so emit no continuation — the caller must
      // raise maxChars instead.
      const completeLines = (sourceText.match(/\n/g) ?? []).length;
      const resume = returnedStart + completeLines;
      if (resume > returnedStart && resume <= totalLines) {
        nextStartLine = resume;
      }
    } else if (returnedEnd < totalLines) {
      nextStartLine = returnedEnd + 1;
    }
  }

  return {
    sourceText,
    totalLines,
    returnedStart,
    returnedEnd,
    truncated,
    charsTruncated,
    ...(nextStartLine != null ? { nextStartLine } : {})
  };
}
