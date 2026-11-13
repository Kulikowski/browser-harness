import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameDecoder, MAX_INCOMING, encodeFrame, nativeChannel } from "../../src/bridge/nativeMessaging.js";
import { ChunkJoiner, HOST_MESSAGE_LIMIT, isChunk, splitMessage } from "../../src/shared/chunks.js";

describe("native messaging frames", () => {
  it("prefixes UTF-8 JSON with its byte length, little-endian", () => {
    const frame = encodeFrame({ text: "zażółć" });
    const body = JSON.stringify({ text: "zażółć" });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body));
    expect(frame.subarray(4).toString("utf8")).toBe(body);
  });

  it("decodes frames split anywhere, including mid-character", () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "ćma" }), encodeFrame([3])]);
    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...decoder.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([{ a: 1 }, { b: "ćma" }, [3]]);
  });

  it("refuses a length over Chrome's 64 MiB limit", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_INCOMING + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(/64 MiB/);
  });
});

describe("chunking for Chrome's 1 MB host limit", () => {
  it("passes small messages through untouched", () => {
    expect(splitMessage({ a: 1 }, "x")).toEqual([{ a: 1 }]);
  });

  it("splits a big message into frames that each fit, and joins them back in any order", () => {
    const message = { type: "browser.callResult", data: "😀ł".repeat(400_000) + '"\\' };
    const frames = splitMessage(message, "id1");
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(encodeFrame(frame).length - 4).toBeLessThan(HOST_MESSAGE_LIMIT);
    const joiner = new ChunkJoiner();
    const shuffled = [...frames].reverse();
    let result: unknown;
    for (const frame of shuffled) {
      expect(isChunk(frame)).toBe(true);
      result = joiner.add(frame as never) ?? result;
    }
    expect(result).toEqual(message);
    expect(joiner.waiting).toBe(0);
  });

  it("rejects malformed chunks", () => {
    expect(() => new ChunkJoiner().add({ type: "chunk", chunkId: "a", index: 2, total: 2, part: "" })).toThrow(
      /Malformed/
    );
  });

  it("the channel sends chunked frames that the extension side can join", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = nativeChannel(input, output);
    const big = { data: "x".repeat(HOST_MESSAGE_LIMIT * 2) };
    channel.send(big);
    output.end();
    const bytes: Buffer[] = [];
    for await (const chunk of output) bytes.push(chunk as Buffer);
    const frames = new FrameDecoder().push(Buffer.concat(bytes));
    const joiner = new ChunkJoiner();
    let result: unknown;
    for (const frame of frames) result = joiner.add(frame as never) ?? result;
    expect(result).toEqual(big);
  });
});
