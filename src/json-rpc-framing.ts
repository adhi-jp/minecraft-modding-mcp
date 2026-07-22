import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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
  return JSONRPCMessageSchema.parse(JSON.parse(json));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
  private discardBodyBytesRemaining = 0n;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? loadMaxFrameBytes();
  }

  get currentMode(): FramingMode {
    return this.mode;
  }

  reset(): void {
    this.mode = "unknown";
    this.awaitedFrameEnd = -1;
    this.discardBodyBytesRemaining = 0n;
  }

  clear(): void {
    this.mode = "unknown";
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.awaitedFrameEnd = -1;
    this.discardBodyBytesRemaining = 0n;
  }

  processChunk(
    chunk: Buffer,
    handlers: {
      onFrame: (frame: ParsedJsonRpcFrame) => void;
      onError: (error: Error) => void;
    }
  ): void {
    if (chunk.length === 0) {
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
        if (this.discardBodyBytesRemaining > 0n) {
          this.discardAvailableBodyBytes();
          if (this.discardBodyBytesRemaining > 0n) {
            return;
          }
          continue;
        }

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
        this.mode = "unknown";
        this.awaitedFrameEnd = -1;
        handlers.onError(asError(caughtError));
      }
    }
  }

  private canCompleteFrame(chunk: Buffer): boolean {
    if (this.discardBodyBytesRemaining > 0n) {
      return true;
    }

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
      const observedBytes = this.buffer.length;
      this.buffer = Buffer.alloc(0);
      throw new Error(
        `Content-Length header is ${observedBytes} bytes, exceeding the header limit of ` +
        `${MAX_CONTENT_LENGTH_HEADER_BYTES} bytes.`
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

  private beginBodyDiscard(messageStart: number, contentLength: bigint): void {
    this.buffer = this.buffer.subarray(messageStart);
    this.discardBodyBytesRemaining = contentLength;
    this.awaitedFrameEnd = -1;
    this.mode = "unknown";
    this.discardAvailableBodyBytes();
  }

  private discardAvailableBodyBytes(): void {
    const availableBytes = BigInt(this.buffer.length);
    const discardedBytes =
      this.discardBodyBytesRemaining < availableBytes
        ? this.discardBodyBytesRemaining
        : availableBytes;
    this.buffer = this.buffer.subarray(Number(discardedBytes));
    this.discardBodyBytesRemaining -= discardedBytes;
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
        const separator = this.buffer.length > 0 && this.buffer[0] === 0x0d ? "\r\n" : "\n";
        this.buffer = Buffer.concat([Buffer.from(`${line}${separator}`, "utf8"), this.buffer]);
        this.mode = "content-length";
        return undefined;
      }

      return parseJsonRpcMessage(line);
    }
  }

  private readContentLengthMessage(): JSONRPCMessage | undefined {
    this.awaitedFrameEnd = -1;
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
      this.beginBodyDiscard(messageStart, contentLength);
      throw new Error(
        `Content-Length ${contentLength.toString()} exceeds the configured frame limit of ` +
        `${this.maxFrameBytes} bytes.`
      );
    }
    if (messageStart > MAX_CONTENT_LENGTH_HEADER_BYTES) {
      this.beginBodyDiscard(messageStart, contentLength);
      throw new Error(
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
    return parseJsonRpcMessage(body);
  }
}
