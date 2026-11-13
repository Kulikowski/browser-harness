import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "../../src/shared/acp.js";
import { stripPageContext } from "../../src/shared/context.js";
import { applyEvent, newChat, pendingDecisions, type Chat, type ChatEvent } from "../../src/shared/transcript.js";

const start = () => newChat({ id: "c1", harnessId: "claude", harnessName: "Claude Code", cwd: "/w", now: 0 });
const fold = (events: ChatEvent[], chat: Chat = start()) =>
  events.reduce((acc, event, i) => applyEvent(acc, event, (i + 1) * 100), chat);
const update = (u: Record<string, unknown>, replay = false): ChatEvent => ({
  type: "update",
  update: u as unknown as SessionUpdate,
  replay
});
const text = (t: string) => ({ type: "text", text: t });

describe("applyEvent", () => {
  it("joins streamed message chunks into one agent message, and closes thinking when the answer starts", () => {
    const chat = fold([
      { type: "ready", acpSessionId: "s", modes: [], currentModeId: null, replayed: false },
      { type: "prompt", id: "u1", text: "hello", page: null },
      update({ sessionUpdate: "agent_thought_chunk", content: text("Thinking ") }),
      update({ sessionUpdate: "agent_thought_chunk", content: text("hard") }),
      update({ sessionUpdate: "agent_message_chunk", content: text("Hi ") }),
      update({ sessionUpdate: "agent_message_chunk", content: text("there") })
    ]);
    expect(chat.items.map((item) => item.kind)).toEqual(["user", "thought", "agent"]);
    expect(chat.items[1]).toMatchObject({ text: "Thinking hard", startedAt: 300, endedAt: 500 });
    expect(chat.items[2]).toMatchObject({ text: "Hi there" });
    expect(chat.title).toBe("hello");
    expect(chat.state).toBe("working");
  });

  it("tracks a tool call through its updates, keeping fields the update leaves out", () => {
    const chat = fold([
      { type: "prompt", id: "u1", text: "go", page: null },
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Click Save",
        kind: "execute",
        status: "pending",
        rawInput: { ref: 4 }
      }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: text("Clicked") }]
      })
    ]);
    expect(chat.items[1]).toMatchObject({
      kind: "tool",
      title: "Click Save",
      toolKind: "execute",
      status: "completed",
      input: { ref: 4 },
      output: "Clicked",
      startedAt: 200,
      endedAt: 400
    });
  });

  it("waits for the user while a permission is open, then goes back to working", () => {
    let chat = fold([
      { type: "prompt", id: "u1", text: "go", page: null },
      {
        type: "permission",
        requestId: "r1",
        toolCall: { toolCallId: "t1", title: "Run add_todo", rawInput: { text: "x" } },
        options: [{ optionId: "a", name: "Allow once", kind: "allow_once" }]
      }
    ]);
    expect(chat.state).toBe("waiting");
    expect(pendingDecisions(chat)).toHaveLength(1);
    expect(chat.items.find((item) => item.kind === "tool")).toMatchObject({ id: "t1", title: "Run add_todo" });
    chat = applyEvent(
      chat,
      {
        type: "permission-resolved",
        requestId: "r1",
        outcome: { optionId: "a", name: "Allow once", kind: "allow_once" }
      },
      900
    );
    expect(chat.state).toBe("working");
    expect(pendingDecisions(chat)).toHaveLength(0);
  });

  it("stays waiting while a second decision is still open", () => {
    const chat = fold([
      { type: "prompt", id: "u1", text: "go", page: null },
      { type: "permission", requestId: "r1", toolCall: { toolCallId: "t1" }, options: [] },
      {
        type: "approval",
        id: "ap1",
        tool: "click",
        args: {},
        origin: "https://a.example",
        reason: "r",
        category: "submit"
      },
      { type: "permission-resolved", requestId: "r1", outcome: "cancelled" }
    ]);
    expect(chat.state).toBe("waiting");
    expect(pendingDecisions(chat).map((item) => item.id)).toEqual(["ap1"]);
  });

  it("on a cancelled turn withdraws open questions and fails running tools", () => {
    const chat = fold([
      { type: "prompt", id: "u1", text: "go", page: null },
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Wait", status: "in_progress" }),
      { type: "permission", requestId: "r1", toolCall: { toolCallId: "t2" }, options: [] },
      { type: "approval", id: "ap1", tool: "click", args: {}, origin: "o", reason: "r", category: "submit" },
      { type: "turn-ended", stopReason: "cancelled" }
    ]);
    expect(chat.state).toBe("idle");
    expect(chat.items.find((item) => item.id === "t1")).toMatchObject({ status: "failed" });
    expect(chat.items.find((item) => item.id === "r1")).toMatchObject({ outcome: "cancelled" });
    expect(chat.items.find((item) => item.id === "ap1")).toMatchObject({ outcome: "expired" });
    expect(chat.items.at(-1)).toMatchObject({ kind: "turn-end", stopReason: "cancelled", durationMs: 400 });
  });

  it("replaces the plan within a turn and starts a new one in the next turn", () => {
    const plan = (n: number) =>
      update({ sessionUpdate: "plan", entries: [{ content: `step ${n}`, priority: "medium", status: "pending" }] });
    const chat = fold([
      { type: "prompt", id: "u1", text: "a", page: null },
      plan(1),
      plan(2),
      { type: "prompt", id: "u2", text: "b", page: null },
      plan(3)
    ]);
    const plans = chat.items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(2);
    expect(plans.map((item) => (item.kind === "plan" ? item.entries[0]!.content : ""))).toEqual(["step 2", "step 3"]);
  });

  it("only takes user chunks from history replay, and titles the chat from them", () => {
    const live = fold([update({ sessionUpdate: "user_message_chunk", content: text("ignored") })]);
    expect(live.items).toHaveLength(0);
    const replayed = fold([
      { type: "reset-for-replay" },
      update({ sessionUpdate: "user_message_chunk", content: text("Fix the poster") }, true),
      update({ sessionUpdate: "agent_message_chunk", content: text("Done") }, true)
    ]);
    expect(replayed.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(replayed.title).toBe("Fix the poster");
  });

  it("takes titles from session_info_update and clips long ones", () => {
    const chat = fold([update({ sessionUpdate: "session_info_update", title: "x".repeat(100) })]);
    expect(chat.title).toHaveLength(60);
    expect(chat.title.endsWith("…")).toBe(true);
  });

  // Regression: Claude Code titles a session from its first prompt, which starts with our tab line.
  it("keeps the extension's tab line out of titles and replayed user messages", () => {
    const tabLine =
      '[The user is looking at tab 5: "Board" https://a.example/. It offers 1 WebMCP tools: x. Use the browser MCP server.]\n\n';
    const titled = fold([update({ sessionUpdate: "session_info_update", title: `${tabLine}list tools` })]);
    expect(titled.title).toBe("list tools");
    const replayed = fold([
      update({ sessionUpdate: "user_message_chunk", content: text(tabLine.slice(0, 30)) }, true),
      update({ sessionUpdate: "user_message_chunk", content: text(`${tabLine.slice(30)}Fix the poster`) }, true)
    ]);
    const user = replayed.items[0];
    expect(user?.kind === "user" && stripPageContext(user.text)).toBe("Fix the poster");
    expect(replayed.title).toBe("Fix the poster");
    const clipped = fold([update({ sessionUpdate: "session_info_update", title: tabLine.slice(0, 50) })]);
    expect(clipped.title).toBe("New chat");
  });

  it("follows mode changes", () => {
    const chat = fold([
      {
        type: "ready",
        acpSessionId: "s",
        modes: [
          { id: "ask", name: "Ask" },
          { id: "auto", name: "Auto" }
        ],
        currentModeId: "ask",
        replayed: false
      },
      update({ sessionUpdate: "current_mode_update", currentModeId: "auto" })
    ]);
    expect(chat.currentModeId).toBe("auto");
  });

  it("clips very long tool output", () => {
    const chat = fold([
      update({ sessionUpdate: "tool_call", toolCallId: "t", rawOutput: "y".repeat(5000), status: "completed" })
    ]);
    const tool = chat.items[0];
    expect(tool?.kind === "tool" && tool.output).toMatch(/1000 more characters$/);
  });

  it("does not mutate the chat it was given", () => {
    const before = fold([{ type: "prompt", id: "u1", text: "go", page: null }]);
    const snapshot = JSON.stringify(before);
    applyEvent(before, update({ sessionUpdate: "agent_message_chunk", content: text("x") }), 5);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
