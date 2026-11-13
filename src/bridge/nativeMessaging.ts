/**
 * Chrome native messaging framing: each message is UTF-8 JSON preceded by its length as a 32-bit
 * unsigned integer in native byte order (little-endian on every platform Chrome ships for).
 */
import type { Readable, Writable } from "node:stream";
import { splitMessage } from "../shared/chunks.js";

/** Chrome sends at most 64 MiB to a host; anything larger is a broken stream, not a message. */
export const MAX_INCOMING = 64 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feed bytes; returns every complete message they finish. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_INCOMING) throw new Error(`Native message of ${length} bytes is over the 64 MiB limit`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

export interface NativeChannel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
}

export function nativeChannel(input: Readable, output: Writable): NativeChannel {
  const decoder = new FrameDecoder();
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let chunkSeq = 0;
  input.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) for (const listener of messageListeners) listener(message);
  });
  const closed = () => {
    for (const listener of closeListeners.splice(0)) listener();
  };
  input.on("end", closed);
  input.on("close", closed);
  return {
    send(message) {
      chunkSeq += 1;
      for (const frame of splitMessage(message, `c${process.pid}-${chunkSeq}`)) output.write(encodeFrame(frame));
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    }
  };
}
