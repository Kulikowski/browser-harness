#!/usr/bin/env node
/**
 * A scripted ACP agent for tests and demos without any real harness or account. It behaves like a
 * real one where it matters to the extension: it speaks ACP v1 over stdio, starts the MCP servers
 * it is given in session/new and calls the browser through them, streams thoughts and text, asks
 * for permission with session/request_permission, honours session/cancel, and supports
 * session/list, session/load (with replay) and session/resume across restarts.
 *
 * Prompts it understands (anything else is echoed):
 *   list tools | call <tool> <json> | snapshot | click <name> | type <text> into <name> | wait | wait <ms>
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { messageOf } from "../shared/errors.js";

interface Stored {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  history: { role: "user" | "agent"; text: string }[];
}

interface Live {
  stored: Stored;
  mcp: Client | null;
  abort: AbortController | null;
  alwaysAllowed: Set<string>;
}

const stateFile = join(
  process.env.BROWSER_HARNESS_FAKE_STATE_DIR ?? join(tmpdir(), "browser-harness-fake"),
  "sessions.json"
);
const live = new Map<string, Live>();

function loadStore(): Record<string, Stored> {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Stored>;
  } catch {
    return {};
  }
}

function save(stored: Stored): void {
  const all = loadStore();
  all[stored.sessionId] = stored;
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(all, null, 2));
}

async function startMcp(servers: acp.McpServer[]): Promise<Client | null> {
  const server = servers.find((entry): entry is acp.McpServerStdio => "command" in entry && entry.name === "browser");
  if (!server) return null;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  for (const variable of server.env ?? []) env[variable.name] = variable.value;
  const client = new Client({ name: "fake-agent", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "inherit" })
  );
  return client;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    });
  });

function textOfResult(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");
}

async function open(sessionId: string, cwd: string, servers: acp.McpServer[], stored?: Stored): Promise<Live> {
  const previous = live.get(sessionId);
  await previous?.mcp?.close().catch(() => undefined);
  const session: Live = {
    stored: stored ?? { sessionId, cwd, title: null, updatedAt: new Date().toISOString(), history: [] },
    mcp: await startMcp(servers),
    abort: null,
    alwaysAllowed: new Set()
  };
  live.set(sessionId, session);
  return session;
}

function modes() {
  return {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask first", description: "Ask before every browser action" },
      { id: "auto", name: "Auto", description: "Run browser actions without asking" }
    ]
  };
}

async function turn(session: Live, text: string, cx: acp.AgentContext, signal: AbortSignal): Promise<string> {
  const sessionId = session.stored.sessionId;
  const say = (chunk: string) =>
    cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } }
    });
  const think = (chunk: string) =>
    cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } }
    });
  // Like a real harness, a call that needed permission keeps the toolCallId the permission named.
  const tool = async (
    name: string,
    args: Record<string, unknown>,
    title: string,
    kind: acp.ToolKind = "fetch",
    existingId?: string
  ) => {
    if (!session.mcp) throw new Error("No browser MCP server was passed in session/new.");
    const toolCallId = existingId ?? `tc-${randomUUID().slice(0, 8)}`;
    if (!existingId)
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput: args }
      });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" }
    });
    const result = await session.mcp.callTool({ name, arguments: args });
    const output = textOfResult(result);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: result.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: output } }]
      }
    });
    return { output, isError: !!result.isError, toolCallId };
  };

  await think("Reading the request. ");
  await sleep(40, signal);

  // The extension puts a line about the tab first; the user's words are the last paragraph.
  const said = (text.split("\n\n").at(-1) ?? text).trim();
  const lower = said.toLowerCase();
  if (lower === "pretend signed out") {
    // What signed-out Claude Code does: the session opens, the first prompt fails.
    throw acp.RequestError.authRequired();
  }
  if (lower === "list tools") {
    await think("I'll ask the tab which WebMCP tools it offers.");
    const listed = await tool("webmcp_list_tools", {}, "List the page's WebMCP tools");
    const names = [...listed.output.matchAll(/^- ([^\s:(]+)/gm)].map((match) => match[1]);
    const reply = names.length
      ? `This tab offers ${names.length} WebMCP tools: ${names.join(", ")}.`
      : "This tab offers no WebMCP tools.";
    await say(reply);
    return reply;
  }

  const call = said.match(/^call (\S+)\s*(\{.*\})?\s*$/s);
  if (call) {
    const name = call[1]!;
    const args = call[2] ? (JSON.parse(call[2]) as Record<string, unknown>) : {};
    const toolCallId = `tc-${randomUUID().slice(0, 8)}`;
    const title = `Run browser tool ${name}`;
    const rawInput = { name, arguments: args };
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId, title, kind: "execute", status: "pending", rawInput }
    });
    if (!session.alwaysAllowed.has(name)) {
      const answer = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId, title, kind: "execute", status: "pending", rawInput },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: `Always allow ${name}`, kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" }
        ]
      });
      if (answer.outcome.outcome === "cancelled") throw new Error("cancelled");
      if (answer.outcome.optionId === "deny") {
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Denied by the user." } }]
          }
        });
        const reply = `Understood, I won't run ${name}.`;
        await say(reply);
        return reply;
      }
      if (answer.outcome.optionId === "always") session.alwaysAllowed.add(name);
    }
    const result = await tool("webmcp_call_tool", rawInput, title, "execute", toolCallId);
    const reply = result.isError ? `${name} failed: ${result.output}` : `Done. ${name} returned ${result.output}`;
    await say(reply);
    return reply;
  }

  if (lower === "snapshot") {
    const snap = await tool("snapshot", {}, "Read the page", "read");
    const reply = `The page reads:\n${snap.output.split("\n").slice(0, 12).join("\n")}`;
    await say(reply);
    return reply;
  }

  const click = said.match(/^click (.+)$/i);
  if (click) {
    const snap = await tool("snapshot", {}, "Read the page", "read");
    const ref = findRef(snap.output, click[1]!.trim());
    if (ref === null) {
      const reply = `I couldn't find "${click[1]}" on the page.`;
      await say(reply);
      return reply;
    }
    const clicked = await tool("click", { ref }, `Click "${click[1]}"`, "execute");
    const reply = clicked.isError
      ? `The click didn't happen: ${clicked.output}`
      : `Clicked "${click[1]}". ${clicked.output}`;
    await say(reply);
    return reply;
  }

  const type = said.match(/^type (.+) into (.+)$/i);
  if (type) {
    const snap = await tool("snapshot", {}, "Read the page", "read");
    const ref = findRef(snap.output, type[2]!.trim());
    if (ref === null) {
      const reply = `I couldn't find a field called "${type[2]}".`;
      await say(reply);
      return reply;
    }
    const typed = await tool("type", { ref, text: type[1] }, `Type into "${type[2]}"`, "edit");
    const reply = typed.isError ? `Typing failed: ${typed.output}` : `Typed it. ${typed.output}`;
    await say(reply);
    return reply;
  }

  const timed = lower.match(/^wait (\d{1,5})$/);
  if (timed) {
    await say("Working for a while");
    await sleep(Number(timed[1]), signal);
    await say(" and done.");
    return "Working for a while and done.";
  }

  if (lower === "wait") {
    await say("Working on something long");
    for (;;) {
      await sleep(200, signal);
      await say(".");
    }
  }

  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the message", priority: "medium", status: "completed" },
        { content: "Answer", priority: "medium", status: "in_progress" }
      ]
    }
  });
  const words = `You said: ${said}`.split(" ");
  for (const word of words) {
    await say(`${word} `);
    await sleep(15, signal);
  }
  return words.join(" ");
}

function findRef(snapshot: string, name: string): number | null {
  const wanted = name.toLowerCase().replace(/^"|"$/g, "");
  for (const line of snapshot.split("\n")) {
    const match = line.match(/\[(\d+)\] [\w-]+ "([^"]*)"/);
    if (match && match[2]!.toLowerCase().includes(wanted)) return Number(match[1]);
  }
  return null;
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
);

acp
  .agent({ name: "webmcp-fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      promptCapabilities: { embeddedContext: false, image: false }
    },
    agentInfo: { name: "webmcp-fake-agent", title: "Scripted test agent", version: "0.1.0" },
    authMethods: [
      {
        id: "agent-login",
        name: "Log in with the test agent",
        description: "Pretends to sign in; nothing leaves the machine."
      }
    ]
  }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = `fake-${randomUUID()}`;
    const session = await open(sessionId, ctx.params.cwd, ctx.params.mcpServers);
    save(session.stored);
    return { sessionId, modes: modes() };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const stored = loadStore()[ctx.params.sessionId];
    if (!stored) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    await open(stored.sessionId, ctx.params.cwd, ctx.params.mcpServers, stored);
    for (const entry of stored.history) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: stored.sessionId,
        update: {
          sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: entry.text }
        }
      });
    }
    return { modes: modes() };
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx) => {
    const stored = loadStore()[ctx.params.sessionId];
    if (!stored) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    await open(stored.sessionId, ctx.params.cwd, ctx.params.mcpServers ?? [], stored);
    return { modes: modes() };
  })
  .onRequest(acp.methods.agent.session.list, (ctx) => ({
    sessions: Object.values(loadStore())
      .filter((stored) => !ctx.params.cwd || stored.cwd === ctx.params.cwd)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt }))
  }))
  .onRequest(acp.methods.agent.session.close, async (ctx) => {
    const session = live.get(ctx.params.sessionId);
    session?.abort?.abort();
    await session?.mcp?.close().catch(() => undefined);
    live.delete(ctx.params.sessionId);
    return {};
  })
  // Like claude-agent-acp, the answer is the confirmation: no current_mode_update follows a mode the
  // client asked for itself. Only a mode the agent changes on its own is announced.
  .onRequest(acp.methods.agent.session.setMode, async () => ({}))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = live.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const text = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    session.abort?.abort();
    const abort = new AbortController();
    session.abort = abort;
    session.stored.history.push({ role: "user", text: text.split("\n\n").at(-1) ?? text });
    session.stored.title ??= (text.split("\n\n").at(-1) ?? text).slice(0, 50);
    try {
      const reply = await turn(session, text, ctx.client, abort.signal);
      session.stored.history.push({ role: "agent", text: reply });
      return { stopReason: "end_turn" as const };
    } catch (error) {
      if (abort.signal.aborted || messageOf(error) === "cancelled") return { stopReason: "cancelled" as const };
      throw error;
    } finally {
      session.stored.updatedAt = new Date().toISOString();
      save(session.stored);
      if (session.abort === abort) session.abort = null;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    live.get(ctx.params.sessionId)?.abort?.abort();
  })
  .connect(stream);
