import { createError, ERROR_CODES } from "./errors.js";

type GateOptions = {
  maxConcurrent: number;
  maxQueue: number;
};

type PendingEntry = {
  tool: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const DEFAULT_OPTIONS: GateOptions = {
  maxConcurrent: 1,
  maxQueue: 2
};

// Heavy tools that have a batch equivalent able to collapse many same-kind
// queries into a single gated call. Used to point overflow guidance at the
// right batch-* tool instead of just telling the caller to retry serially.
const BATCH_EQUIVALENTS: Record<string, string> = {
  "find-mapping": "batch-mappings",
  "resolve-method-mapping-exact": "batch-mappings"
};

export class ToolExecutionGate {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private activeCount = 0;
  private readonly queue: PendingEntry[] = [];

  constructor(options: Partial<GateOptions> = {}) {
    this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? DEFAULT_OPTIONS.maxConcurrent));
    this.maxQueue = Math.max(0, Math.trunc(options.maxQueue ?? DEFAULT_OPTIONS.maxQueue));
  }

  run<T>(tool: string, task: () => Promise<T>): Promise<T> {
    if (this.activeCount < this.maxConcurrent) {
      return this.execute({ tool, task: task as () => Promise<unknown> }) as Promise<T>;
    }

    if (this.queue.length >= this.maxQueue) {
      const batchTool = BATCH_EQUIVALENTS[tool];
      const nextAction = batchTool
        ? `Retry after the current heavy analysis request completes. To run many ${tool} queries efficiently, collapse them into a single ${batchTool} call instead of issuing them in parallel.`
        : "Retry after the current heavy analysis request completes. Avoid sending multiple heavy mapping/version analysis tools in parallel.";
      return Promise.reject(
        createError({
          code: ERROR_CODES.LIMIT_EXCEEDED,
          message: `Heavy tool queue is full; "${tool}" was not started.`,
          details: {
            tool,
            activeCount: this.activeCount,
            queuedCount: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            maxQueue: this.maxQueue,
            nextAction
          }
        })
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        tool,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      });
    });
  }

  private execute(entry: { tool: string; task: () => Promise<unknown> }): Promise<unknown> {
    this.activeCount += 1;
    return Promise.resolve()
      .then(entry.task)
      .finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.drain();
      });
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift() as PendingEntry;
      this.execute(next).then(next.resolve, next.reject);
    }
  }
}
