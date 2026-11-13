#!/usr/bin/env node
/**
 * The browser, as an MCP server over stdio. The harness starts this per session (we pass it in
 * session/new's mcpServers), and it forwards every request to the bridge's tool relay.
 * Environment: BROWSER_HARNESS_SOCKET, BROWSER_HARNESS_TOKEN, BROWSER_HARNESS_CHAT.
 */
import { connect, type Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolDescription, ToolResult } from "../shared/protocol.js";
import type { ShimReply } from "./toolRelay.js";

const socketPath = process.env.BROWSER_HARNESS_SOCKET;
const token = process.env.BROWSER_HARNESS_TOKEN;
const chatId = process.env.BROWSER_HARNESS_CHAT || null;

if (!socketPath || !token) {
  process.stderr.write(
    "browser-harness browser tools: started without the bridge's socket; the bridge passes it when it opens a session.\n"
  );
  process.exit(2);
}

const pending = new Map<number, (reply: ShimReply) => void>();
let seq = 0;
let onToolsChanged: () => void = () => undefined;

const relay: Socket = connect(socketPath);
const welcomed = new Promise<void>((resolve, reject) => {
  let buffer = "";
  relay.setEncoding("utf8");
  relay.on("data", (data: string) => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, newline)) as ShimReply;
      buffer = buffer.slice(newline + 1);
      if (reply.type === "welcome") resolve();
      else if (reply.type === "toolsChanged") onToolsChanged();
      else if ("id" in reply && typeof reply.id === "number") {
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      }
    }
  });
  relay.on("error", reject);
  relay.on("close", () => {
    for (const resolveReply of pending.values()) resolveReply({ type: "error", message: "The browser bridge closed." });
    pending.clear();
    process.exit(0);
  });
});
relay.write(`${JSON.stringify({ type: "hello", token, chatId })}\n`);

function ask(
  request: { type: "list" } | { type: "call"; name: string; arguments: Record<string, unknown> }
): Promise<ShimReply> {
  seq += 1;
  const id = seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    relay.write(`${JSON.stringify({ ...request, id })}\n`);
  });
}

const server = new Server({ name: "browser", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await welcomed;
  const reply = await ask({ type: "list" });
  if (reply.type === "error") throw new Error(reply.message);
  const tools = reply.type === "list" ? reply.tools : [];
  return {
    tools: tools.map((tool: McpToolDescription) => ({ ...tool, inputSchema: tool.inputSchema as { type: "object" } }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await welcomed;
  const reply = await ask({
    type: "call",
    name: request.params.name,
    arguments: (request.params.arguments ?? {}) as Record<string, unknown>
  });
  if (reply.type === "call") return reply.result as ToolResult & Record<string, unknown>;
  return {
    isError: true,
    content: [{ type: "text", text: reply.type === "error" ? reply.message : "No answer from the browser." }]
  };
});

onToolsChanged = () => {
  void server.sendToolListChanged().catch(() => undefined);
};

await welcomed;
await server.connect(new StdioServerTransport());
