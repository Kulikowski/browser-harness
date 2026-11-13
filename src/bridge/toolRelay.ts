/**
 * The way back from the harness to the browser. Each harness session starts our MCP shim
 * (mcpShim.ts) as a stdio MCP server; the shim dials this Unix socket, proves it was started by
 * us with a per-bridge token, and forwards tools/list and tools/call. The relay hands them to the
 * extension and returns its answer.
 *
 * The socket lives in a fresh 0700 directory, and the token is 32 random bytes, so another local
 * user or a stray process cannot drive the browser through it.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { McpToolDescription, ToolResult } from "../shared/protocol.js";
import { messageOf } from "../shared/errors.js";

export type ShimRequest =
  | { type: "hello"; token: string; chatId: string | null }
  | { type: "list"; id: number }
  | { type: "call"; id: number; name: string; arguments: Record<string, unknown> };

export type ShimReply =
  | { type: "welcome" }
  | { type: "list"; id: number; tools: McpToolDescription[] }
  | { type: "call"; id: number; result: ToolResult }
  | { type: "toolsChanged" }
  | { type: "error"; id?: number; message: string };

export interface RelayHandlers {
  listTools(chatId: string | null): Promise<McpToolDescription[]>;
  callTool(chatId: string | null, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRelay {
  private server: Server | null = null;
  private dir: string | null = null;
  readonly token = randomBytes(32).toString("hex");
  private readonly clients = new Set<Socket>();
  socketPath = "";

  constructor(private readonly handlers: RelayHandlers) {}

  async start(): Promise<string> {
    this.dir = await mkdtemp(join(tmpdir(), "browser-harness-"));
    this.socketPath = join(this.dir, "relay.sock");
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    return this.socketPath;
  }

  toolsChanged(): void {
    for (const socket of this.clients) write(socket, { type: "toolsChanged" });
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  private accept(socket: Socket): void {
    let chatId: string | null = null;
    let trusted = false;
    let buffer = "";
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 8 * 1024 * 1024) return socket.destroy();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: ShimRequest;
        try {
          request = JSON.parse(line) as ShimRequest;
        } catch {
          socket.destroy();
          return;
        }
        if (!trusted) {
          if (request.type !== "hello" || !sameToken(request.token, this.token)) {
            socket.destroy();
            return;
          }
          trusted = true;
          chatId = request.chatId;
          clearTimeout(timer);
          this.clients.add(socket);
          write(socket, { type: "welcome" });
          continue;
        }
        void this.serve(socket, chatId, request);
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      this.clients.delete(socket);
    });
    socket.on("error", () => socket.destroy());
  }

  private async serve(socket: Socket, chatId: string | null, request: ShimRequest): Promise<void> {
    if (request.type === "list") {
      try {
        write(socket, { type: "list", id: request.id, tools: await this.handlers.listTools(chatId) });
      } catch (error) {
        write(socket, { type: "error", id: request.id, message: messageOf(error) });
      }
    } else if (request.type === "call") {
      try {
        write(socket, {
          type: "call",
          id: request.id,
          result: await this.handlers.callTool(chatId, request.name, request.arguments ?? {})
        });
      } catch (error) {
        write(socket, {
          type: "call",
          id: request.id,
          result: { isError: true, content: [{ type: "text", text: messageOf(error) }] }
        });
      }
    }
  }
}

function write(socket: Socket, reply: ShimReply): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
