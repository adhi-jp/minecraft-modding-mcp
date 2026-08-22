import { parseJSONRPCMessage, type JSONRPCMessage } from "@modelcontextprotocol/server";

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MIN_MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CONTENT_LENGTH_HEADER_BYTES = 8 * 1024;

export type FramingMode = "unknown" | "line" | "content-length";
export type ConcreteFramingMode = Exclude<FramingMode, "unknown">;

export type ParsedJsonRpcFrame = {
  message: JSONRPCMessage;
  mode: ConcreteFramingMode;
};

type HeaderBoundary = {
  index: number;
  delimiterBytes: number;
};

function findHeaderBoundary(buffer: Buffer): HeaderBoundary | undefined {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  if (crlfBoundary !== -1) {
    return { index: crlfBoundary, delimiterBytes: 4 };
  }

  const lfBoundary = buffer.indexOf("\n\n");
  if (lfBoundary !== -1) {
    return { index: lfBoundary, delimiterBytes: 2 };
  }

  return undefined;
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
 *  - a Content-Length body that is not valid JSON — under-declaration,
 *    over-declaration and an honestly-framed bad body are indistinguishable,
 *    and the first two have already desynchronized the stream,
 *  - duplicate Content-Length headers — the body length is ambiguous,
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
  private mode: FramingMode = "unknown";
  private buffer = Buffer.alloc(0);
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private awaitedFrameEnd = -1;
  private fatal = false;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? loadMaxFrameBytes();
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
    this.mode = "unknown";
    this.awaitedFrameEnd = -1;
    this.fatal = false;
  }

  clear(): void {
    this.mode = "unknown";
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.awaitedFrameEnd = -1;
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

        handlers.onFrame({
          message,
          mode: this.mode
        });
      } catch (caughtError) {
        const error = asError(caughtError);
        this.mode = "unknown";
        this.awaitedFrameEnd = -1;
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
        // Always re-inject with CRLF: choosing the separator from the next
        // buffered byte raced byte-granular chunking (the peer's \r may not
        // have arrived yet, yielding a "\n\r\n" boundary findHeaderBoundary
        // cannot see). With CRLF both peer styles stay recognizable:
        // "...\r\n" + "\r\n…" → "\r\n\r\n", "...\r\n" + "\n…" → "\n\n".
        this.buffer = Buffer.concat([Buffer.from(`${line}\r\n`, "utf8"), this.buffer]);
        this.mode = "content-length";
        return undefined;
      }

      return parseJsonRpcMessage(line);
    }
  }

  private readContentLengthMessage(): JSONRPCMessage | undefined {
    this.awaitedFrameEnd = -1;

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

    let contentLength: bigint | undefined;
    for (const headerLine of headerLines) {
      const separatorIndex = headerLine.indexOf(":");
      if (separatorIndex === -1) {
        this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
        throw new Error(`Malformed header line: ${headerLine}`);
      }

      const headerName = headerLine.slice(0, separatorIndex).trim().toLowerCase();
      const headerValue = headerLine.slice(separatorIndex + 1).trim();

      if (headerName === "content-length") {
        if (contentLength !== undefined) {
          // Two declarations, no way to tell which delimits the body: the
          // classic frame-smuggling shape. Last-wins would hand an attacker
          // the choice of where the reader thinks this frame ends.
          throw new JsonRpcFramingFatalError(
            `Duplicate Content-Length header (${contentLength.toString()} then ${headerValue}): the ` +
            "declared body length is ambiguous, so the reader cannot determine where this frame " +
            "ends; the stdio session is terminated."
          );
        }
        if (!/^[0-9]+$/.test(headerValue)) {
          this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
          throw new Error(`Invalid Content-Length header value: ${headerValue}`);
        }
        contentLength = BigInt(headerValue);
      }
    }

    if (contentLength === undefined) {
      this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
      throw new Error("Missing Content-Length header.");
    }

    const messageStart = headerBoundary.index + headerBoundary.delimiterBytes;
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
