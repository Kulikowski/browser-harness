/** Test double for the extension: starts the real built bridge and speaks native messaging to it. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChunkJoiner, isChunk } from "../../src/shared/chunks.js";
import type { FromBridge, McpToolDescription, ToBridge } from "../../src/shared/protocol.js";
import { encodeFrame, FrameDecoder } from "../../src/bridge/nativeMessaging.js";

export const DIST = join(import.meta.dirname, "..", "..", "dist", "bridge");

export class FakeExtension {
  readonly child: ChildProcess;
  readonly received: FromBridge[] = [];
  private readonly listeners = new Set<(message: FromBridge) => void>();
  private seq = 0;
  readonly stateDir = mkdtempSync(join(tmpdir(), "fake-agent-state-"));
  readonly workspace = mkdtempSync(join(tmpdir(), "harness-ws-"));

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [join(DIST, "host.js"), "chrome-extension://test/"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        BROWSER_HARNESS_FAKE_AGENT: join(DIST, "fakeAgent.js"),
        BROWSER_HARNESS_FAKE_STATE_DIR: this.stateDir,
        BROWSER_HARNESS_WORKSPACE: this.workspace,
        ...env
      }
    });
    const decoder = new FrameDecoder();
    const joiner = new ChunkJoiner();
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const message = (isChunk(raw) ? joiner.add(raw) : raw) as FromBridge | undefined;
        if (!message) continue;
        this.received.push(message);
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  post(message: ToBridge): void {
    this.child.stdin!.write(encodeFrame(message));
  }

  async request<T = unknown>(message: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    this.seq += 1;
    const id = `t${this.seq}`;
    const reply = this.next((m) => m.type === "reply" && m.id === id, timeoutMs);
    this.post({ ...message, id } as ToBridge);
    const answer = (await reply) as Extract<FromBridge, { type: "reply" }>;
    if (!answer.ok) throw Object.assign(new Error(answer.error), { reply: answer });
    return answer.data as T;
  }

  /** Resolves with the first message (already received or future) matching the predicate. */
  next(
    predicate: (message: FromBridge) => boolean,
    timeoutMs = 10_000,
    fromIndex = this.received.length
  ): Promise<FromBridge> {
    const already = this.received.slice(fromIndex).find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting; last messages: ${JSON.stringify(this.received.slice(-5)).slice(0, 800)}`));
      }, timeoutMs);
      const listener = (message: FromBridge) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      this.listeners.add(listener);
    });
  }

  /** Answer browser tool calls like the extension would, with empty input schemas. */
  serveBrowser(
    tools: { name: string; description: string }[],
    call: (name: string, args: Record<string, unknown>) => string
  ): void {
    this.serveBrowserTools(
      tools.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } })),
      call
    );
  }

  /** Like serveBrowser, with the tools' own input schemas. */
  serveBrowserTools(tools: McpToolDescription[], call: (name: string, args: Record<string, unknown>) => string): void {
    this.onMessage((message) => {
      if (message.type === "browser.listTools") {
        this.post({ type: "browser.toolsResult", callId: message.callId, tools });
      } else if (message.type === "browser.call") {
        this.post({
          type: "browser.callResult",
          callId: message.callId,
          result: { content: [{ type: "text", text: call(message.name, message.arguments) }] }
        });
      }
    });
  }

  onMessage(listener: (message: FromBridge) => void): void {
    this.listeners.add(listener);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      this.child.stdin!.end();
    });
  }
}
