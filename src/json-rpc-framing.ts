import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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
  private mode: FramingMode = "unknown";
  private buffer = Buffer.alloc(0);

  get currentMode(): FramingMode {
    return this.mode;
  }

  reset(): void {
    this.mode = "unknown";
  }

  clear(): void {
    this.mode = "unknown";
    this.buffer = Buffer.alloc(0);
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

    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      try {
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
        handlers.onError(asError(caughtError));
      }
    }
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
    const headerBoundary = findHeaderBoundary(this.buffer);
    if (!headerBoundary) {
      return undefined;
    }

    const headersRaw = this.buffer.subarray(0, headerBoundary.index).toString("utf8");
    const headerLines = headersRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let contentLength: number | undefined;
    for (const headerLine of headerLines) {
      const separatorIndex = headerLine.indexOf(":");
      if (separatorIndex === -1) {
        this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
        throw new Error(`Malformed header line: ${headerLine}`);
      }

      const headerName = headerLine.slice(0, separatorIndex).trim().toLowerCase();
      const headerValue = headerLine.slice(separatorIndex + 1).trim();

      if (headerName === "content-length") {
        const parsed = Number.parseInt(headerValue, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
          throw new Error(`Invalid Content-Length header value: ${headerValue}`);
        }
        contentLength = parsed;
      }
    }

    if (contentLength === undefined) {
      this.buffer = this.buffer.subarray(headerBoundary.index + headerBoundary.delimiterBytes);
      throw new Error("Missing Content-Length header.");
    }

    const messageStart = headerBoundary.index + headerBoundary.delimiterBytes;
    const frameEnd = messageStart + contentLength;
    if (this.buffer.length < frameEnd) {
      return undefined;
    }

    const body = this.buffer.subarray(messageStart, frameEnd).toString("utf8");
    this.buffer = this.buffer.subarray(frameEnd);
    return parseJsonRpcMessage(body);
  }
}
