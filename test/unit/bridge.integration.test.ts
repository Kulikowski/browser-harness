/**
 * The real bridge (built), the real ACP SDK, the real MCP shim, and the scripted fake agent:
 * everything between Chrome and a harness, without Chrome or a harness account.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DIST, FakeExtension } from "./hostHarness.js";
import type { FromBridge, HarnessInfo } from "../../src/shared/protocol.js";

let ext: FakeExtension | null = null;

beforeAll(() => {
  if (!existsSync(join(DIST, "host.js")))
    throw new Error("Run npm run build first: the integration tests drive dist/bridge/host.js.");
});

afterEach(async () => {
  await ext?.close();
  ext = null;
});

const updates = (messages: FromBridge[], chatId: string) =>
  messages
    .filter(
      (m): m is Extract<FromBridge, { type: "session.update" }> => m.type === "session.update" && m.chatId === chatId
    )
    .map((m) => m.update);

describe("bridge over native messaging", () => {
  it("says hello with a protocol version, a default folder and the harnesses it found", async () => {
    ext = new FakeExtension();
    const hello = await ext.request<{ bridgeVersion: number; defaultCwd: string; found: HarnessInfo[] }>({
      type: "hello",
      extensionVersion: "test"
    });
    expect(hello.bridgeVersion).toBe(1);
    expect(hello.defaultCwd).toBe(ext.workspace);
    expect(hello.found.map((h) => h.id)).toContain("fake");
  });

  it("gives each chat its own ACP session and streams the turn back", async () => {
    ext = new FakeExtension();
    await ext.request({ type: "hello", extensionVersion: "test" });
    const a = await ext.request<{ acpSessionId: string }>({
      type: "session.new",
      chatId: "chat-a",
      harnessId: "fake",
      cwd: ext.workspace
    });
    const b = await ext.request<{ acpSessionId: string }>({
      type: "session.new",
      chatId: "chat-b",
      harnessId: "fake",
      cwd: ext.workspace
    });
    expect(a.acpSessionId).not.toBe(b.acpSessionId);

    await ext.request({ type: "session.prompt", chatId: "chat-a", text: "hello there", pageContext: null });
    const ended = await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "chat-a");
    expect(ended).toMatchObject({ stopReason: "end_turn" });
    const kinds = updates(ext.received, "chat-a").map((u) => u.sessionUpdate);
    expect(kinds).toContain("agent_thought_chunk");
    expect(kinds).toContain("plan");
    const text = updates(ext.received, "chat-a")
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text: string } }).content.text)
      .join("");
    expect(text.trim()).toBe("You said: hello there");
    expect(updates(ext.received, "chat-b")).toHaveLength(0);
  });

  // Regression: real Claude Code (claude-agent-acp, signed out) opens a session fine and only fails
  // on the first prompt with -32000 "Authentication required". That must reach the panel as a
  // sign-in problem with the harness's own hint, not as a bare turn error.
  it("reports a sign-in needed during a prompt as authRequired with the harness's hint", async () => {
    ext = new FakeExtension();
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "c", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "c", text: "pretend signed out", pageContext: null });
    const ended = await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "c");
    expect(ended).toMatchObject({
      stopReason: "error",
      authRequired: [{ id: "agent-login", name: "Log in with the test agent" }]
    });
    expect((ended as { error: string }).error).toMatch(
      /^Authentication required\. Sign in to the harness in a terminal/
    );
  });

  it("lets the harness reach the browser through the MCP server passed in session/new", async () => {
    ext = new FakeExtension();
    ext.serveBrowser(
      [{ name: "webmcp_set_fader", description: "Set a fader" }],
      () => "- set_fader: Set a fader\n- recall_scene: Recall a scene"
    );
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "c", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "c", text: "list tools", pageContext: "[tab context]" });
    await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "c");
    const call = ext.received.find((m) => m.type === "browser.call");
    expect(call).toMatchObject({ type: "browser.call", chatId: "c", harnessId: "fake", name: "webmcp_list_tools" });
    const reply = updates(ext.received, "c")
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text: string } }).content.text)
      .join("");
    expect(reply).toBe("This tab offers 2 WebMCP tools: set_fader, recall_scene.");
  });

  it("hands the harness's permission request to the extension and returns the user's choice", async () => {
    ext = new FakeExtension();
    ext.serveBrowser([], (name, args) => `called ${name} with ${JSON.stringify(args)}`);
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "p", harnessId: "fake", cwd: ext.workspace });
    await ext.request({
      type: "session.prompt",
      chatId: "p",
      text: 'call go_live {"confirm":true}',
      pageContext: null
    });
    const permission = (await ext.next((m) => m.type === "permission.request")) as Extract<
      FromBridge,
      { type: "permission.request" }
    >;
    expect(permission.chatId).toBe("p");
    expect(permission.toolCall.title).toBe("Run browser tool go_live");
    expect(permission.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    ext.post({ type: "permission.respond", requestId: permission.requestId, optionId: "allow" });
    await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "p");
    const call = ext.received.find((m) => m.type === "browser.call");
    expect(call).toMatchObject({
      name: "webmcp_call_tool",
      arguments: { name: "go_live", arguments: { confirm: true } }
    });
  });

  it("tells the harness when the user declines, and nothing reaches the browser", async () => {
    ext = new FakeExtension();
    ext.serveBrowser([], () => "should not happen");
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "d", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "d", text: "call go_live {}", pageContext: null });
    const permission = (await ext.next((m) => m.type === "permission.request")) as Extract<
      FromBridge,
      { type: "permission.request" }
    >;
    ext.post({ type: "permission.respond", requestId: permission.requestId, optionId: "deny" });
    await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "d");
    expect(ext.received.some((m) => m.type === "browser.call")).toBe(false);
  });

  it("cancels a running turn, withdrawing nothing it did not ask", async () => {
    ext = new FakeExtension();
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "w", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "w", text: "wait", pageContext: null });
    await ext.next(
      (m) => m.type === "session.update" && m.chatId === "w" && m.update.sessionUpdate === "agent_message_chunk"
    );
    const before = ext.received.length;
    await ext.request({ type: "session.cancel", chatId: "w" });
    const ended = await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "w", 10_000, before);
    expect(ended).toMatchObject({ stopReason: "cancelled" });
  });

  it("cancelling while the harness waits for permission answers that request with cancelled", async () => {
    ext = new FakeExtension();
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "x", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "x", text: "call go_live {}", pageContext: null });
    const permission = (await ext.next((m) => m.type === "permission.request")) as Extract<
      FromBridge,
      { type: "permission.request" }
    >;
    const before = ext.received.length;
    await ext.request({ type: "session.cancel", chatId: "x" });
    await ext.next((m) => m.type === "permission.withdrawn" && m.requestId === permission.requestId, 10_000, before);
    const ended = await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "x", 10_000, before);
    expect(ended).toMatchObject({ stopReason: "cancelled" });
  });

  it("lists sessions and reopens one after the bridge restarts, replaying history with session/load", async () => {
    ext = new FakeExtension();
    await ext.request({ type: "hello", extensionVersion: "test" });
    const { acpSessionId } = await ext.request<{ acpSessionId: string }>({
      type: "session.new",
      chatId: "r",
      harnessId: "fake",
      cwd: ext.workspace
    });
    await ext.request({ type: "session.prompt", chatId: "r", text: "remember me", pageContext: null });
    await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "r");
    const stateDir = ext.stateDir;
    await ext.close();

    ext = new FakeExtension({ BROWSER_HARNESS_FAKE_STATE_DIR: stateDir });
    await ext.request({ type: "hello", extensionVersion: "test" });
    const listed = await ext.request<{ supported: boolean; sessions: { sessionId: string; title: string }[] }>({
      type: "session.list",
      harnessId: "fake",
      cwd: null
    });
    expect(listed.supported).toBe(true);
    expect(listed.sessions.map((s) => s.sessionId)).toContain(acpSessionId);

    const opened = await ext.request<{ replayed: boolean }>({
      type: "session.reopen",
      chatId: "r2",
      harnessId: "fake",
      acpSessionId,
      cwd: ext.workspace,
      wantHistory: true
    });
    expect(opened.replayed).toBe(true);
    const replay = ext.received.filter((m) => m.type === "session.update" && m.chatId === "r2");
    expect(replay.every((m) => m.type === "session.update" && m.replay)).toBe(true);
    expect(replay.map((m) => (m.type === "session.update" ? m.update.sessionUpdate : ""))).toEqual([
      "user_message_chunk",
      "agent_message_chunk"
    ]);

    const resumed = await ext.request<{ replayed: boolean }>({
      type: "session.reopen",
      chatId: "r3",
      harnessId: "fake",
      acpSessionId,
      cwd: ext.workspace,
      wantHistory: false
    });
    expect(resumed.replayed).toBe(false);
  });

  it("refuses to open a harness that is not installed", async () => {
    // An empty search path: the test must not find (and start) a real Codex on the developer's machine.
    ext = new FakeExtension({ BROWSER_HARNESS_FAKE_AGENT: "", BROWSER_HARNESS_SEARCH_PATH: "" });
    await ext.request({ type: "hello", extensionVersion: "test" });
    await expect(
      ext.request({ type: "session.new", chatId: "n", harnessId: "codex", cwd: ext.workspace })
    ).rejects.toThrow(/not installed/);
  });

  it("splits replies over Chrome's 1 MB host limit into chunks that join back", async () => {
    ext = new FakeExtension();
    const big = "x".repeat(1_500_000);
    ext.serveBrowser([], () => big);
    await ext.request({ type: "hello", extensionVersion: "test" });
    await ext.request({ type: "session.new", chatId: "big", harnessId: "fake", cwd: ext.workspace });
    await ext.request({ type: "session.prompt", chatId: "big", text: "snapshot", pageContext: null });
    await ext.next((m) => m.type === "session.turnEnded" && m.chatId === "big", 20_000);
    const update = updates(ext.received, "big").find(
      (u) => u.sessionUpdate === "tool_call_update" && JSON.stringify(u).length > 1_000_000
    );
    expect(update).toBeDefined();
  });
});
