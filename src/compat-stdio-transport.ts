import process from "node:process";

import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type FramingMode = "unknown" | "line" | "content-length";

type StdioReadable = NodeJS.ReadStream;
type StdioWritable = NodeJS.WriteStream;

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

export class CompatStdioServerTransport {
  private readonly stdin: StdioReadable;
  private readonly stdout: StdioWritable;
  private started = false;
  private closed = false;
  private mode: FramingMode = "unknown";
  private buffer = Buffer.alloc(0);

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(stdin: StdioReadable = process.stdin, stdout: StdioWritable = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        "CompatStdioServerTransport already started. connect() should be called only once."
      );
    }

    this.started = true;
    this.stdin.on("data", this.handleData);
    this.stdin.on("error", this.handleStreamError);
    this.stdin.on("end", this.handleStreamClosed);
    this.stdin.on("close", this.handleStreamClosed);
    this.stdin.resume();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const json = JSON.stringify(message);
    const frame =
      this.mode === "content-length"
        ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
        : `${json}\n`;

    await new Promise<void>((resolve) => {
      if (this.stdout.write(frame)) {
        resolve();
        return;
      }
      this.stdout.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    this.stdin.off("data", this.handleData);
    this.stdin.off("error", this.handleStreamError);
    this.stdin.off("end", this.handleStreamClosed);
    this.stdin.off("close", this.handleStreamClosed);

    if (this.stdin.listenerCount("data") === 0) {
      this.stdin.pause();
    }

    this.buffer = Buffer.alloc(0);
    this.emitCloseOnce();
  }

  private readonly handleData = (chunk: Buffer): void => {
    if (chunk.length === 0) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processReadBuffer();
  };

  private readonly handleStreamError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly handleStreamClosed = (): void => {
    this.emitCloseOnce();
  };

  private emitCloseOnce(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.onclose?.();
  }

  private processReadBuffer(): void {
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
          // readLineDelimitedMessage may switch mode to "content-length"
          // mid-stream; retry with the new parser instead of stopping.
          if (this.mode !== modeBefore) {
            continue;
          }
          return;
        }

        this.onmessage?.(message);
      } catch (caughtError) {
        this.onerror?.(asError(caughtError));
        this.mode = "unknown";
      }
    }
  }

  private detectMode(): FramingMode | undefined {
    // Skip blank leading lines that some clients may emit.
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
        // Reconstruct the header with the correct line ending so that
        // findHeaderBoundary can locate \r\n\r\n or \n\n reliably.
        const sep = this.buffer.length > 0 && this.buffer[0] === 0x0d ? "\r\n" : "\n";
        this.buffer = Buffer.concat([Buffer.from(`${line}${sep}`, "utf8"), this.buffer]);
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
