import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";

import { parseJSONRPCMessage, type JSONRPCMessage } from "@modelcontextprotocol/server";

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MIN_MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CONTENT_LENGTH_HEADER_BYTES = 8 * 1024;
const DEFAULT_INCOMPLETE_FRAME_IDLE_MS = 30_000;

export type FramingMode = "unknown" | "line" | "content-length";
export type ConcreteFramingMode = Exclude<FramingMode, "unknown">;

export type ParsedJsonRpcFrame = {
  message: JSONRPCMessage;
  mode: ConcreteFramingMode;
};

/**
 * The opaque handle a {@link JsonRpcFrameReader}'s idle-budget timer is
 * identified by. Only the reader's own scheduler/clearer pair interprets it,
 * so a test can substitute a plain object for a real timer.
 */
export type FrameIdleTimerHandle = unknown;
export type FrameIdleTimerScheduler = (
  callback: () => void,
  delayMs: number
) => FrameIdleTimerHandle;
export type FrameIdleTimerClearer = (handle: FrameIdleTimerHandle) => void;

const scheduleIdleTimer: FrameIdleTimerScheduler = (callback, delayMs) => {
  const timer = setNodeTimeout(callback, delayMs);
  // The budget must never be the reason a process stays alive: a reader parked
  // on an incomplete body would otherwise hold the event loop open for the
  // whole budget after every other handle had closed.
  timer.unref();
  return timer;
};

const clearIdleTimerHandle: FrameIdleTimerClearer = (handle) => {
  clearNodeTimeout(handle as ReturnType<typeof setNodeTimeout>);
};

type HeaderBoundary = {
  index: number;
  delimiterBytes: number;
};

/**
 * The end of the header block: the FIRST EMPTY LINE in the buffer.
 *
 * One rule generates every terminator style instead of a list of literals to
 * match. A header line ends at an LF, and a CR immediately before that LF
 * belongs to the terminator rather than to the line; the block ends at the
 * first line that holds nothing but its own terminator. `index` is the first
 * byte of that terminating sequence — so `buffer.slice(0, index)` is exactly
 * the header text — and `delimiterBytes` spans through the empty line's LF, so
 * the body opens at `index + delimiterBytes`. The four shapes a peer can
 * produce are consequences, not cases:
 *
 *     "\r\n\r\n" → 4 bytes      "\r\n\n" → 3 bytes
 *     "\n\r\n"   → 3 bytes      "\n\n"   → 2 bytes
 *
 * Scanning forward from byte 0 is also what keeps a real terminator ahead of
 * any byte sequence inside a body: preferring a CRLFCRLF found ANYWHERE over
 * an earlier LFLF mis-framed every LF-framed peer whose JSON body happened to
 * contain a raw `\r\n\r\n` — legal inter-token whitespace — because the header
 * block was then cut at a boundary inside the body, losing that frame and the
 * next. A single forward scan cannot reach the body before the block ends, so
 * no body byte can outrank the terminator and no two readings compete.
 *
 * Consequence worth stating, because it is load-bearing for the caller: an
 * EXTRA empty line after the terminator is body, not header. The body window
 * then opens on that empty line and is shifted by the two or three bytes the
 * peer did not count, so it no longer covers the same span as the JSON value.
 * All four extra-blank-line shapes behave alike here, which is the point: the
 * reading does not depend on which terminator style the peer chose.
 *
 * What that shift COSTS is a separate question, and the answer is not always
 * "the frame". The usual outcome is a window running off the end of the JSON,
 * `readContentLengthMessage`'s body-parse failure and a framing-fatal — see
 * {@link JsonRpcFramingFatalError}. But the window is only shifted, not
 * mis-sized, so trailing whitespace INSIDE the declared length can absorb the
 * shift exactly: a length that counts two trailing spaces, against two
 * uncounted leading bytes, lands the window on `"\r\n" + <json>`, which
 * `JSON.parse` accepts. Such a frame is delivered normally. The reader does
 * not detect the extra blank line; it only ever sees where the bytes fall.
 */
function findHeaderBoundary(buffer: Buffer): HeaderBoundary | undefined {
  let searchFrom = 0;
  while (true) {
    const lineEnd = buffer.indexOf(0x0a, searchFrom);
    if (lineEnd === -1) {
      return undefined;
    }

    // The next line starts immediately after that LF. It is the empty line
    // when the only bytes it holds are its own terminator: an optional CR and
    // then an LF. An out-of-range read is `undefined`, which matches neither
    // byte, so a truncated tail simply keeps the scan waiting for more input.
    let cursor = lineEnd + 1;
    if (buffer[cursor] === 0x0d) {
      cursor += 1;
    }
    if (buffer[cursor] === 0x0a) {
      // A CR in front of the FIRST LF terminates the preceding header line, so
      // it is part of the delimiter, not of the headers. Guarding on
      // `lineEnd > 0` keeps the lookbehind inside the buffer when the block is
      // terminated at byte 0.
      const index = lineEnd > 0 && buffer[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
      return { index, delimiterBytes: cursor + 1 - index };
    }

    searchFrom = lineEnd + 1;
  }
}

function parseJsonRpcMessage(json: string): JSONRPCMessage {
  return parseJSONRPCMessage(JSON.parse(json));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * A framing violation the reader cannot provably recover from.
 *
 * The reader's framing invariant is: after ANY framing violation it either
 * provably resynchronizes — resuming at a byte position the peer itself
 * delimited — or it terminates the session with a diagnostic. It must never
 * silently consume subsequent valid frames, and it must never wait on bytes
 * an untrusted declared length says are coming.
 *
 * Recoverable violations (plain `Error`, reader keeps running):
 *  - a line-delimited frame that is oversized or unparseable — the newline
 *    that terminates it is a delimiter the reader can prove,
 *  - a Content-Length header block carrying no usable length at all
 *    (`Content-Length: nope`, a missing header, a malformed header line) —
 *    the CRLFCRLF boundary delimits the header block and no body length was
 *    ever declared, so only the header block is consumed,
 *  - an oversized Content-Length frame whose complete declared body is ALREADY
 *    buffered — dropping exactly those bytes lands on the byte the peer named
 *    as the next frame's first,
 *  - a Content-Length body that is valid JSON but not a valid JSON-RPC message
 *    — valid JSON of exactly the declared length proves the boundary was
 *    right, so this is a message-level error, not a framing one.
 *
 * Fatal violations (this class, reader stops permanently):
 *  - an oversized Content-Length whose declared body has NOT fully arrived
 *    (waiting on it is what let a single unanswerable header wedge the
 *    transport for the process lifetime),
 *  - an UNDER-limit Content-Length whose declared body stops arriving for the
 *    incomplete-frame idle budget — the same wedge, below the size check,
 *  - a Content-Length body that is not valid JSON — under-declaration,
 *    over-declaration and an honestly-framed bad body are indistinguishable,
 *    and the first two have already desynchronized the stream,
 *  - a header block that declared a body length and then contradicted it
 *    (duplicate Content-Length headers, a non-numeric value alongside a
 *    numeric one, junk after a good declaration) — bytes the peer counted as
 *    body would otherwise be re-read as frames,
 *  - a Content-Length header block that never terminates within the header
 *    limit — there is no delimiter left to resynchronize on.
 */
export class JsonRpcFramingFatalError extends Error {
  readonly framingFatal = true;

  constructor(message: string) {
    super(message);
    this.name = "JsonRpcFramingFatalError";
  }
}

/**
 * Whether an error reported through `processChunk`'s `onError` handler ends
 * the session. Every transport that owns a {@link JsonRpcFrameReader} MUST
 * check this and tear its session down: the reader has stopped accepting
 * input, so ignoring the signal would leave a silently deaf transport.
 */
export function isJsonRpcFramingFatalError(error: unknown): error is JsonRpcFramingFatalError {
  return error instanceof JsonRpcFramingFatalError;
}

export function loadMaxFrameBytes(value = process.env.MCP_MAX_FRAME_BYTES): number {
  if (!/^[0-9]+$/.test(value ?? "")) {
    return DEFAULT_MAX_FRAME_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_MAX_FRAME_BYTES;
  }
  return Math.max(parsed, MIN_MAX_FRAME_BYTES);
}

export function encodeJsonRpcMessage(
  message: JSONRPCMessage,
  mode: ConcreteFramingMode
): Buffer {
  const json = JSON.stringify(message);
  return Buffer.from(
    mode === "content-length"
      ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
      : `${json}\n`,
    "utf8"
  );
}

export class JsonRpcFrameReader {
  private readonly maxFrameBytes: number;
  private readonly incompleteFrameIdleMs: number;
  private readonly scheduleTimer: FrameIdleTimerScheduler;
  private readonly clearTimer: FrameIdleTimerClearer;
  private mode: FramingMode = "unknown";
  private buffer = Buffer.alloc(0);
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private awaitedFrameEnd = -1;
  private awaitedBodyStart = -1;
  private idleTimer: FrameIdleTimerHandle | undefined;
  private fatal = false;

  /**
   * @param options.maxFrameBytes Largest accepted frame; defaults to
   *   {@link loadMaxFrameBytes}.
   * @param options.incompleteFrameIdleMs How long a declared Content-Length
   *   body may stop arriving before the session is terminated. This is IDLE
   *   time, not total time: every arriving byte clears and re-arms it, so a
   *   legitimately slow or very large body is never cut off. Defaults to
   *   30 000 ms; a non-positive or non-finite value disables the budget.
   * @param options.timerScheduler Schedules the idle budget; defaults to an
   *   `unref()`'d `setTimeout`. Injectable so tests can drive it directly.
   * @param options.timerClearer Cancels a handle from `timerScheduler`.
   */
  constructor(
    options: {
      maxFrameBytes?: number;
      incompleteFrameIdleMs?: number;
      timerScheduler?: FrameIdleTimerScheduler;
      timerClearer?: FrameIdleTimerClearer;
    } = {}
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? loadMaxFrameBytes();
    this.incompleteFrameIdleMs = options.incompleteFrameIdleMs ?? DEFAULT_INCOMPLETE_FRAME_IDLE_MS;
    this.scheduleTimer = options.timerScheduler ?? scheduleIdleTimer;
    this.clearTimer = options.timerClearer ?? clearIdleTimerHandle;
  }

  get currentMode(): FramingMode {
    return this.mode;
  }

  /**
   * Whether an unrecoverable framing violation has stopped this reader. No
   * further input is examined and no further frame is ever emitted until
   * `reset()` or `clear()` explicitly re-arms it.
   */
  get isFatal(): boolean {
    return this.fatal;
  }

  reset(): void {
    this.clearIdleTimer();
    this.mode = "unknown";
    this.awaitedFrameEnd = -1;
    this.awaitedBodyStart = -1;
    this.fatal = false;
  }

  clear(): void {
    this.clearIdleTimer();
    this.mode = "unknown";
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.awaitedFrameEnd = -1;
    this.awaitedBodyStart = -1;
    this.fatal = false;
  }

  processChunk(
    chunk: Buffer,
    handlers: {
      onFrame: (frame: ParsedJsonRpcFrame) => void;
      onError: (error: Error) => void;
    }
  ): void {
    if (chunk.length === 0 || this.fatal) {
      return;
    }

    // Bytes arrived, so any pending idle budget is stale; it is re-armed below
    // only if this chunk leaves a declared body still incomplete.
    this.clearIdleTimer();
    try {
      this.drainChunk(chunk, handlers);
    } finally {
      this.armIdleTimer(handlers);
    }
  }

  private drainChunk(
    chunk: Buffer,
    handlers: {
      onFrame: (frame: ParsedJsonRpcFrame) => void;
      onError: (error: Error) => void;
    }
  ): void {
    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    if (!this.canCompleteFrame(chunk)) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, ...this.pendingChunks]);
    this.pendingChunks = [];
    this.pendingBytes = 0;

    while (true) {
      try {
        this.rejectOversizedIncompleteInput();

        if (this.mode === "unknown") {
          const detected = this.detectMode();
          if (!detected) {
            return;
          }
          this.mode = detected;
          continue;
        }

        const modeBefore = this.mode;
        const message =
          this.mode === "content-length"
            ? this.readContentLengthMessage()
            : this.readLineDelimitedMessage();

        if (!message) {
          if (this.mode !== modeBefore) {
            continue;
          }
          return;
        }

        try {
          handlers.onFrame({
            message,
            mode: this.mode
          });
        } catch (handlerError) {
          // The frame HANDLER threw, not the framer. This frame's bytes are
          // already consumed and the framing state describes the stream
          // correctly, so it must survive untouched: sharing the framing
          // try/catch turned a handler bug into a silent framing change (the
          // compat transport picks its response framing from `currentMode`,
          // so a reset here downgraded later replies to line framing) and left
          // the offending request unanswered with no distinguishing signal.
          // The failure is still surfaced through `onError` — the path every
          // transport already handles — but as a plain Error, so a handler can
          // never forge the framing-fatal signal that tears a session down.
          const handlerFault = asError(handlerError);
          handlers.onError(
            new Error(`JSON-RPC frame handler failed: ${handlerFault.message}`, {
              cause: handlerFault
            })
          );
        }
      } catch (caughtError) {
        const error = asError(caughtError);
        this.mode = "unknown";
        this.awaitedFrameEnd = -1;
        this.awaitedBodyStart = -1;
        if (error instanceof JsonRpcFramingFatalError) {
          // Terminal: drop everything buffered and refuse all further input so
          // no byte after the violation can be mistaken for a frame. The
          // transport owns the teardown.
          this.fatal = true;
          this.buffer = Buffer.alloc(0);
          this.pendingChunks = [];
          this.pendingBytes = 0;
          handlers.onError(error);
          return;
        }
        handlers.onError(error);
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) {
      return;
    }
    const handle = this.idleTimer;
    this.idleTimer = undefined;
    this.clearTimer(handle);
  }

  /**
   * Puts an incomplete declared body on an idle clock.
   *
   * A Content-Length UNDER the frame limit whose body never arrives was the
   * one wedge the size check could not see: `readContentLengthMessage` armed
   * `awaitedFrameEnd`, `canCompleteFrame` then refused to look at anything
   * until that many bytes existed, and every later frame piled up behind a
   * body that was never coming. The budget is idle time — the caller clears it
   * on every arriving chunk and this re-arms it — so only a stream that has
   * gone silent mid-body is terminated.
   *
   * `onError` belongs to a `processChunk` call, so the timer fires through the
   * handlers of the MOST RECENT call rather than the one that armed it. Every
   * caller in this repository passes a stable handler pair on every chunk, and
   * a caller that does not still gets a live pair rather than a stale one.
   */
  private armIdleTimer(handlers: { onError: (error: Error) => void }): void {
    if (this.fatal || this.awaitedFrameEnd < 0 || this.awaitedBodyStart < 0) {
      return;
    }
    if (!Number.isFinite(this.incompleteFrameIdleMs) || this.incompleteFrameIdleMs <= 0) {
      return;
    }

    let handle: FrameIdleTimerHandle;
    const expire = (): void => {
      if (this.idleTimer === handle) {
        this.idleTimer = undefined;
      }
      if (this.fatal || this.awaitedFrameEnd < 0 || this.awaitedBodyStart < 0) {
        // Cleared, completed or already terminated between scheduling and now.
        return;
      }

      const declaredBytes = this.awaitedFrameEnd - this.awaitedBodyStart;
      const arrivedBytes = Math.max(
        0,
        this.buffer.length + this.pendingBytes - this.awaitedBodyStart
      );
      this.fatal = true;
      this.mode = "unknown";
      this.buffer = Buffer.alloc(0);
      this.pendingChunks = [];
      this.pendingBytes = 0;
      this.awaitedFrameEnd = -1;
      this.awaitedBodyStart = -1;
      handlers.onError(new JsonRpcFramingFatalError(
        `Content-Length declared ${declaredBytes} body bytes but only ${arrivedBytes} arrived ` +
        `within the ${this.incompleteFrameIdleMs} ms incomplete-frame idle budget; the reader ` +
        "cannot resynchronize without trusting bytes that may never be sent, so the stdio " +
        "session is terminated."
      ));
    };

    handle = this.scheduleTimer(expire, this.incompleteFrameIdleMs);
    this.idleTimer = handle;
  }

  private canCompleteFrame(chunk: Buffer): boolean {
    const bufferedBytes = this.buffer.length + this.pendingBytes;
    if (this.mode === "content-length" && this.awaitedFrameEnd >= 0) {
      return bufferedBytes >= this.awaitedFrameEnd;
    }
    if (
      this.mode === "content-length" &&
      bufferedBytes > MAX_CONTENT_LENGTH_HEADER_BYTES
    ) {
      return true;
    }
    return chunk.includes(0x0a) || bufferedBytes > this.maxFrameBytes;
  }

  private rejectOversizedIncompleteInput(): void {
    const headerBoundary =
      this.mode === "content-length" ? findHeaderBoundary(this.buffer) : undefined;
    if (
      this.mode === "content-length" &&
      !headerBoundary &&
      this.buffer.length > MAX_CONTENT_LENGTH_HEADER_BYTES
    ) {
      // No header terminator anywhere in an over-limit header block: there is
      // no delimiter left to resynchronize on (content-length mode has no
      // newline delimiter, and a line frame at the head would already have
      // switched the mode), so the session cannot continue.
      throw new JsonRpcFramingFatalError(
        `Content-Length header is ${this.buffer.length} bytes with no header terminator, exceeding ` +
        `the header limit of ${MAX_CONTENT_LENGTH_HEADER_BYTES} bytes; the stdio session is terminated.`
      );
    }

    if (this.buffer.length <= this.maxFrameBytes) {
      return;
    }
    if (this.mode === "content-length" && headerBoundary) {
      return;
    }
    if (this.mode !== "content-length" && this.buffer.includes(0x0a)) {
      return;
    }

    const observedBytes = this.buffer.length;
    const description =
      this.mode === "line" ? "Line-delimited JSON-RPC frame" : "Headerless JSON-RPC input";
    this.buffer = Buffer.alloc(0);
    throw new Error(
      `${description} is ${observedBytes} bytes, exceeding the configured frame limit of ` +
      `${this.maxFrameBytes} bytes.`
    );
  }

  /**
   * Rejects a Content-Length frame whose declared body can never be accepted
   * (over the frame limit, or behind an over-limit header block).
   *
   * The body is skipped ONLY when every declared byte is already buffered. In
   * that case the skip is a bounded operation on bytes in hand and it resumes
   * at exactly the offset the peer itself named as the next frame's first
   * byte — a resynchronization the reader can prove without extending trust to
   * a single unarrived byte.
   *
   * When the body has NOT fully arrived the reader must not wait for it: the
   * declared length is attacker-controlled, and arming a countdown with it is
   * precisely what let a 29-byte header (`Content-Length: 999999999\r\n\r\n`
   * with no body) silently swallow every later frame for the process lifetime.
   * There is no delimiter to scan forward to either — an arbitrary binary body
   * offers none — so the session is terminated instead.
   */
  private rejectDeclaredBody(messageStart: number, contentLength: bigint, reason: string): never {
    const frameEnd = BigInt(messageStart) + contentLength;
    if (BigInt(this.buffer.length) >= frameEnd) {
      this.buffer = this.buffer.subarray(Number(frameEnd));
      this.awaitedFrameEnd = -1;
      this.awaitedBodyStart = -1;
      this.mode = "unknown";
      throw new Error(reason);
    }
    const arrivedBodyBytes = Math.max(0, this.buffer.length - messageStart);
    throw new JsonRpcFramingFatalError(
      `${reason} Only ${arrivedBodyBytes} of the declared ${contentLength.toString()} body bytes have ` +
      "arrived, so the reader cannot resynchronize without trusting bytes that may never be sent; " +
      "the stdio session is terminated."
    );
  }

  private detectMode(): FramingMode | undefined {
    while (this.buffer.length > 0) {
      if (this.buffer[0] === 0x0a) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length >= 2 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      break;
    }

    if (this.buffer.length === 0) {
      return undefined;
    }

    const prefix = this.buffer
      .subarray(0, Math.min(this.buffer.length, 32))
      .toString("utf8")
      .toLowerCase();
    if (prefix.startsWith("content-length")) {
      return "content-length";
    }

    const firstNewline = this.buffer.indexOf(0x0a);
    if (firstNewline === -1) {
      return undefined;
    }

    const firstLine = this.buffer.subarray(0, firstNewline).toString("utf8").replace(/\r$/, "");
    if (/^\s*content-length\s*:/i.test(firstLine)) {
      return "content-length";
    }

    return "line";
  }

  private readLineDelimitedMessage(): JSONRPCMessage | undefined {
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        return undefined;
      }

      const lineBytes =
        newlineIndex > 0 && this.buffer[newlineIndex - 1] === 0x0d
          ? newlineIndex - 1
          : newlineIndex;
      if (lineBytes > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(newlineIndex + 1);
        throw new Error(
          `Line-delimited JSON-RPC frame is ${lineBytes} bytes, exceeding the configured ` +
          `frame limit of ${this.maxFrameBytes} bytes.`
        );
      }

      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newlineIndex + 1);

      if (line.trim().length === 0) {
        continue;
      }

      if (/^\s*content-length\s*:/i.test(line)) {
        // `line` has already had its trailing \r stripped, so the terminator
        // has to be written back. Always re-inject CRLF: choosing the
        // separator from the next buffered byte raced byte-granular chunking
        // (the peer's \r may not have arrived yet, so the boundary style would
        // depend on read timing rather than on the peer), and this keeps the
        // output independent of arrival.
        //
        // It does not cost the FRAMING: findHeaderBoundary sees an empty line
        // next either way — "...\r\n" + "\r\n…" and "...\r\n" + "\n…" are both
        // first-empty-line boundaries — so no boundary moves. It does cost one
        // BYTE when the peer wrote a bare LF, and that byte is measured
        // against MAX_CONTENT_LENGTH_HEADER_BYTES: an LF-framed header block of
        // exactly 8192 bytes frames on its own, but re-injected here it
        // measures 8193 and is rejected. Exactly one block size is affected —
        // 8192, since anything larger was already over the ceiling — and only
        // when it follows a line-delimited frame, which is why this is left as
        // it stands rather than traded for the chunking race.
        this.buffer = Buffer.concat([Buffer.from(`${line}\r\n`, "utf8"), this.buffer]);
        this.mode = "content-length";
        return undefined;
      }

      return parseJsonRpcMessage(line);
    }
  }

  private readContentLengthMessage(): JSONRPCMessage | undefined {
    this.awaitedFrameEnd = -1;
    this.awaitedBodyStart = -1;

    // Skip blank separator lines between frames so the mid-stream mode check
    // below sees the first byte of the next frame.
    while (this.buffer.length > 0) {
      if (this.buffer[0] === 0x0a) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length >= 2 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      break;
    }

    // Mirror of the line→content-length switch in readLineDelimitedMessage:
    // a JSON object or array opener can never begin a Content-Length header block,
    // so this is a line-delimited frame arriving after a Content-Length frame.
    // Arrays are re-dispatched only to surface their JSON-RPC schema error, not
    // accepted as batch messages. Peek past leading whitespace (pure line mode
    // tolerates it: blank lines are skipped and JSON.parse accepts a
    // whitespace-prefixed line) without consuming it, then switch modes and let
    // processChunk re-dispatch the buffered bytes, so every frame is delivered
    // with its own true mode.
    let probeIndex = 0;
    while (
      probeIndex < this.buffer.length &&
      (this.buffer[probeIndex] === 0x20 ||
        this.buffer[probeIndex] === 0x09 ||
        this.buffer[probeIndex] === 0x0d ||
        this.buffer[probeIndex] === 0x0a)
    ) {
      probeIndex += 1;
    }
    if (
      probeIndex < this.buffer.length &&
      (this.buffer[probeIndex] === 0x7b /* '{' */ ||
        this.buffer[probeIndex] === 0x5b /* '[' */)
    ) {
      this.mode = "line";
      return undefined;
    }

    const headerBoundary = findHeaderBoundary(this.buffer);
    if (!headerBoundary) {
      return undefined;
    }

    const headersRaw = this.buffer.subarray(0, headerBoundary.index).toString("utf8");
    const headerLines = headersRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // The WHOLE block is inspected before anything is thrown. Throwing on the
    // first bad line consumed only the header block, which left the body bytes
    // an EARLIER Content-Length had already declared sitting in the buffer to
    // be re-read as line frames — so `Content-Length: 5x` followed by
    // `Content-Length: 44`, or a good declaration followed by junk, let the
    // peer decide where the reader thought the frame ended.
    let contentLength: bigint | undefined;
    let declaredValue: string | undefined;
    let contentLengthLines = 0;
    let headerFault: string | undefined;
    for (const headerLine of headerLines) {
      const separatorIndex = headerLine.indexOf(":");
      if (separatorIndex === -1) {
        headerFault ??= `Malformed header line: ${headerLine}`;
        continue;
      }

      const headerName = headerLine.slice(0, separatorIndex).trim().toLowerCase();
      const headerValue = headerLine.slice(separatorIndex + 1).trim();
      if (headerName !== "content-length") {
        continue;
      }

      contentLengthLines += 1;
      if (contentLengthLines > 1) {
        // Two declarations, no way to tell which delimits the body: the
        // classic frame-smuggling shape. Last-wins would hand an attacker
        // the choice of where the reader thinks this frame ends.
        headerFault ??=
          `Duplicate Content-Length header (${declaredValue ?? ""} then ${headerValue})`;
        continue;
      }

      declaredValue = headerValue;
      if (!/^[0-9]+$/.test(headerValue)) {
        headerFault ??= `Invalid Content-Length header value: ${headerValue}`;
        continue;
      }
      contentLength = BigInt(headerValue);
    }

    const messageStart = headerBoundary.index + headerBoundary.delimiterBytes;
    if (headerFault !== undefined) {
      this.buffer = this.buffer.subarray(messageStart);
      if (contentLength !== undefined || contentLengthLines > 1) {
        // The block named a body length somewhere and then contradicted it, so
        // bytes the peer counted as body may already be buffered. Consuming
        // only the header block would re-dispatch them as frames.
        throw new JsonRpcFramingFatalError(
          `${headerFault}: the declared body length is ambiguous, so the reader cannot determine ` +
          "where this frame ends; the stdio session is terminated."
        );
      }
      // No usable length was ever declared, so the delimited header block is
      // all there is to consume and the recovery is provable.
      throw new Error(headerFault);
    }

    if (contentLength === undefined) {
      this.buffer = this.buffer.subarray(messageStart);
      throw new Error("Missing Content-Length header.");
    }

    if (contentLength > BigInt(this.maxFrameBytes)) {
      this.rejectDeclaredBody(
        messageStart,
        contentLength,
        `Content-Length ${contentLength.toString()} exceeds the configured frame limit of ` +
        `${this.maxFrameBytes} bytes.`
      );
    }
    if (messageStart > MAX_CONTENT_LENGTH_HEADER_BYTES) {
      this.rejectDeclaredBody(
        messageStart,
        contentLength,
        `Content-Length header is ${messageStart} bytes, exceeding the header limit of ` +
        `${MAX_CONTENT_LENGTH_HEADER_BYTES} bytes.`
      );
    }

    const frameEnd = messageStart + Number(contentLength);
    if (this.buffer.length < frameEnd) {
      this.awaitedFrameEnd = frameEnd;
      this.awaitedBodyStart = messageStart;
      return undefined;
    }

    const body = this.buffer.subarray(messageStart, frameEnd).toString("utf8");
    this.buffer = this.buffer.subarray(frameEnd);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (parseError) {
      // The declared length is the ONLY delimiter a Content-Length frame has,
      // and it just failed its one verification: bytes cut at that offset are
      // not a JSON value. An under-declared length (tail garbage left in the
      // buffer, which used to corrupt the NEXT frame), an over-declared length
      // (the next frame already swallowed into this body) and an honestly
      // framed but malformed body are indistinguishable here — and the first
      // two have already desynchronized the stream. Line framing keeps its
      // recoverable parse errors; its newline proves the boundary.
      throw new JsonRpcFramingFatalError(
        `Content-Length frame body of ${Number(contentLength)} bytes is not valid JSON ` +
        `(${asError(parseError).message}); the declared length cannot be trusted to delimit the ` +
        "next frame, so the stdio session is terminated."
      );
    }
    // Valid JSON of exactly the declared length: the frame boundary is proven,
    // so a JSON-RPC schema violation is an ordinary message-level error.
    return parseJSONRPCMessage(payload);
  }
}
