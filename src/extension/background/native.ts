/** The service worker's end of the native messaging port to the bridge. */
import { ChunkJoiner, isChunk } from "../../shared/chunks.js";
import { NATIVE_HOST_NAME, type FromBridge, type ToBridge } from "../../shared/protocol.js";

type Reply = Extract<FromBridge, { type: "reply" }>;
type Outgoing = ToBridge extends infer T ? (T extends { id: string } ? Omit<T, "id"> : never) : never;

export interface NativeEvents {
  message(message: FromBridge): void;
  disconnected(reason: string, notInstalled: boolean): void;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly reply: Reply | null
  ) {
    super(message);
  }
}

export class NativeBridge {
  private port: chrome.runtime.Port | null = null;
  private readonly waiting = new Map<string, (reply: Reply) => void>();
  private readonly joiner = new ChunkJoiner();
  private seq = 0;

  constructor(private readonly events: NativeEvents) {}

  get connected(): boolean {
    return this.port !== null;
  }

  connect(): void {
    if (this.port) return;
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    this.port = port;
    port.onMessage.addListener((raw: unknown) => {
      const message = isChunk(raw) ? this.joiner.add(raw) : raw;
      if (message === undefined) return;
      const typed = message as FromBridge;
      if (typed.type === "reply") {
        const resolve = this.waiting.get(typed.id);
        this.waiting.delete(typed.id);
        resolve?.(typed);
        return;
      }
      this.events.message(typed);
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? "The bridge closed.";
      this.port = null;
      for (const resolve of this.waiting.values()) resolve({ type: "reply", id: "", ok: false, error: reason });
      this.waiting.clear();
      this.events.disconnected(reason, /not found|forbidden|not allowed/i.test(reason));
    });
  }

  /** Fire and forget. */
  post(message: ToBridge): void {
    if (!this.port) throw new BridgeError("The bridge is not connected.", null);
    this.port.postMessage(message);
  }

  /** Send a request and wait for its reply; rejects with the bridge's error. */
  async request<T = unknown>(message: Outgoing): Promise<T> {
    if (!this.port) throw new BridgeError("The bridge is not connected.", null);
    this.seq += 1;
    const id = `x${this.seq}`;
    const reply = await new Promise<Reply>((resolve) => {
      this.waiting.set(id, resolve);
      this.port!.postMessage({ ...message, id } as ToBridge);
    });
    if (!reply.ok) throw new BridgeError(reply.error, reply);
    return reply.data as T;
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
  }
}
