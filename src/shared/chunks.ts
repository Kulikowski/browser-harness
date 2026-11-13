/**
 * Chrome caps a native-messaging message from the host at 1 MB (developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
 * The bridge splits anything bigger into chunk frames; the extension joins them back.
 */
export const HOST_MESSAGE_LIMIT = 1024 * 1024;
/** Leave room for the chunk envelope and for multi-byte characters, which the limit counts in bytes. */
export const CHUNK_CHARS = 200_000;

export interface ChunkFrame {
  type: "chunk";
  chunkId: string;
  index: number;
  total: number;
  part: string;
}

export function isChunk(value: unknown): value is ChunkFrame {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "chunk";
}

/** Returns the message itself when it fits, otherwise its chunk frames. */
export function splitMessage(message: unknown, chunkId: string, limitBytes = HOST_MESSAGE_LIMIT - 64): unknown[] {
  const json = JSON.stringify(message);
  if (utf8Length(json) <= limitBytes) return [message];
  const total = Math.ceil(json.length / CHUNK_CHARS);
  const frames: ChunkFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    frames.push({
      type: "chunk",
      chunkId,
      index,
      total,
      part: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS)
    });
  }
  return frames;
}

export class ChunkJoiner {
  private readonly pending = new Map<string, string[]>();

  /** Feed a chunk; returns the whole message once the last part arrives. */
  add(frame: ChunkFrame): unknown | undefined {
    if (!Number.isInteger(frame.total) || frame.total < 1 || frame.index < 0 || frame.index >= frame.total) {
      throw new Error(`Malformed chunk ${frame.index}/${frame.total} for ${frame.chunkId}`);
    }
    const parts = this.pending.get(frame.chunkId) ?? new Array<string>(frame.total);
    parts[frame.index] = frame.part;
    this.pending.set(frame.chunkId, parts);
    for (let i = 0; i < frame.total; i += 1) if (parts[i] === undefined) return undefined;
    this.pending.delete(frame.chunkId);
    return JSON.parse(parts.join(""));
  }

  get waiting(): number {
    return this.pending.size;
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
