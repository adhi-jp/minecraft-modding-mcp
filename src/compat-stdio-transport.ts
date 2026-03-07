import process from "node:process";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcFrameReader, encodeJsonRpcMessage } from "./json-rpc-framing.js";

type StdioReadable = NodeJS.ReadStream;
type StdioWritable = NodeJS.WriteStream;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class CompatStdioServerTransport {
  private readonly stdin: StdioReadable;
  private readonly stdout: StdioWritable;
  private readonly frameReader = new JsonRpcFrameReader();
  private started = false;
  private closed = false;

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
    const frame = encodeJsonRpcMessage(
      message,
      this.frameReader.currentMode === "content-length" ? "content-length" : "line"
    );

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

    this.frameReader.clear();
    this.emitCloseOnce();
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.frameReader.processChunk(chunk, {
      onFrame: ({ message }) => {
        this.onmessage?.(message);
      },
      onError: (error) => {
        this.onerror?.(error);
      }
    });
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
}
