export type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "field";

export type SearchResultSymbol = {
  symbolKind: SymbolKind;
  symbolName: string;
  qualifiedName?: string;
  line: number;
};

export type SearchSourceHit = {
  filePath: string;
  score: number;
  matchedIn: "symbol" | "path" | "content";
  reasonCodes: string[];
  symbol?: SearchResultSymbol;
};

export interface SearchCursorPayload {
  score: number;
  filePath: string;
  symbolName: string;
  line: number;
  contextKey?: string;
}

export interface SearchHitAccumulator {
  add(hit: SearchSourceHit): void;
  setTotalApproxOverride(count: number): void;
  currentCount(): number;
  finalize(): {
    page: SearchSourceHit[];
    nextCursorHit?: SearchSourceHit;
    totalApprox: number;
  };
}

export function scoreHitOrder(left: SearchSourceHit, right: SearchSourceHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const pathCompare = left.filePath.localeCompare(right.filePath);
  if (pathCompare !== 0) {
    return pathCompare;
  }

  const leftSymbol = left.symbol?.symbolName ?? "";
  const rightSymbol = right.symbol?.symbolName ?? "";
  const symbolCompare = leftSymbol.localeCompare(rightSymbol);
  if (symbolCompare !== 0) {
    return symbolCompare;
  }

  const leftLine = left.symbol?.line ?? 0;
  const rightLine = right.symbol?.line ?? 0;
  return leftLine - rightLine;
}

export function encodeSearchCursor(hit: SearchSourceHit, contextKey?: string): string {
  return Buffer.from(
    JSON.stringify({
      score: hit.score,
      filePath: hit.filePath,
      symbolName: hit.symbol?.symbolName ?? "",
      line: hit.symbol?.line ?? 0,
      contextKey
    } as SearchCursorPayload),
    "utf8"
  ).toString("base64");
}

export function decodeSearchCursor(cursor: string | undefined): SearchCursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as SearchCursorPayload;
    if (
      typeof parsed.score !== "number" ||
      typeof parsed.filePath !== "string" ||
      typeof parsed.symbolName !== "string" ||
      typeof parsed.line !== "number" ||
      (parsed.contextKey != null && typeof parsed.contextKey !== "string")
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function isAfterSearchCursor(hit: SearchSourceHit, cursor: SearchCursorPayload): boolean {
  if (hit.score < cursor.score) {
    return true;
  }
  if (hit.score > cursor.score) {
    return false;
  }

  const fileCompare = hit.filePath.localeCompare(cursor.filePath);
  if (fileCompare > 0) {
    return true;
  }
  if (fileCompare < 0) {
    return false;
  }

  const hitSymbolName = hit.symbol?.symbolName ?? "";
  const symbolCompare = hitSymbolName.localeCompare(cursor.symbolName);
  if (symbolCompare > 0) {
    return true;
  }
  if (symbolCompare < 0) {
    return false;
  }

  const hitLine = hit.symbol?.line ?? 0;
  return hitLine > cursor.line;
}

/**
 * Binary min-heap that keeps the top-K highest-quality hits.
 * The root is the worst (lowest-quality) item in the heap.
 * Compare function: positive means `a` is worse than `b` (lower quality).
 */
function heapSiftDown(heap: SearchSourceHit[], index: number, size: number): void {
  while (true) {
    let smallest = index;
    const left = 2 * index + 1;
    const right = 2 * index + 2;
    if (left < size && scoreHitOrder(heap[left], heap[smallest]) > 0) {
      smallest = left;
    }
    if (right < size && scoreHitOrder(heap[right], heap[smallest]) > 0) {
      smallest = right;
    }
    if (smallest === index) {
      break;
    }
    const temp = heap[index];
    heap[index] = heap[smallest];
    heap[smallest] = temp;
    index = smallest;
  }
}

function heapSiftUp(heap: SearchSourceHit[], index: number): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    // Keep the worst item at the root: bubble up only when child is worse than parent.
    if (scoreHitOrder(heap[index], heap[parent]) <= 0) {
      break;
    }
    const temp = heap[index];
    heap[index] = heap[parent];
    heap[parent] = temp;
    index = parent;
  }
}

export function createSearchHitAccumulator(
  limit: number,
  cursor: SearchCursorPayload | undefined
): SearchHitAccumulator {
  const pageLimit = Math.max(1, limit);
  const keepLimit = pageLimit + 1;
  const heap: SearchSourceHit[] = [];
  let totalApprox = 0;
  let totalApproxOverride: number | undefined = undefined;
  let totalAfterCursor = 0;

  return {
    add(hit: SearchSourceHit): void {
      totalApprox += 1;
      if (cursor && !isAfterSearchCursor(hit, cursor)) {
        return;
      }

      totalAfterCursor += 1;

      if (heap.length < keepLimit) {
        heap.push(hit);
        heapSiftUp(heap, heap.length - 1);
        return;
      }

      // heap[0] is the worst item in our top-K. If hit is worse or equal, discard.
      if (scoreHitOrder(hit, heap[0]) >= 0) {
        return;
      }

      // Replace root with new hit and restore heap property
      heap[0] = hit;
      heapSiftDown(heap, 0, heap.length);
    },
    setTotalApproxOverride(count: number): void {
      totalApproxOverride = Math.max(0, Math.trunc(count));
    },
    currentCount(): number {
      return heap.length;
    },
    finalize() {
      // Sort heap contents by scoreHitOrder (best first)
      const sorted = heap.slice().sort(scoreHitOrder);
      const page = sorted.slice(0, pageLimit);
      const hasMore = totalAfterCursor > page.length;
      return {
        page,
        nextCursorHit: hasMore && page.length > 0 ? page[page.length - 1] : undefined,
        totalApprox: totalApproxOverride ?? totalApprox
      };
    }
  };
}
