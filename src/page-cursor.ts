// Offset-based continuation cursor for member/row pages. The cursor carries the
// next offset plus a context key derived from the query, so a cursor minted for
// one query is rejected (and the scan restarts) when replayed against another.

type OffsetCursor = {
  offset: number;
  contextKey: string;
};

/** Build a stable context key from the query parameters a cursor belongs to. */
export function buildPageContextKey(parts: Array<string | number | boolean | undefined>): string {
  return parts.map((part) => String(part ?? "")).join("\u0000");
}

export function encodeOffsetCursor(offset: number, contextKey: string): string {
  return Buffer.from(JSON.stringify({ offset, contextKey }), "utf8").toString("base64");
}

export function decodeOffsetCursor(cursor: string | undefined): OffsetCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as OffsetCursor;
    if (typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      return undefined;
    }
    if (typeof parsed.contextKey !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the starting offset from an incoming cursor. Returns offset 0 when the
 * cursor is absent, malformed, or belongs to a different query context, and
 * reports whether a provided cursor was ignored.
 */
export function resolveCursorOffset(
  cursor: string | undefined,
  contextKey: string
): { offset: number; cursorIgnored: boolean } {
  if (cursor == null) {
    return { offset: 0, cursorIgnored: false };
  }
  const decoded = decodeOffsetCursor(cursor);
  if (!decoded || decoded.contextKey !== contextKey) {
    return { offset: 0, cursorIgnored: true };
  }
  return { offset: decoded.offset, cursorIgnored: false };
}
