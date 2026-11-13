/**
 * Opt-in: one real, signed-in turn through the built bridge with an agent installed on this machine.
 *
 *   LIVE_HARNESS=claude npx vitest run test/unit/liveHarness.test.ts
 *   LIVE_HARNESS=antigravity npx vitest run test/unit/liveHarness.test.ts
 *
 * Uses your own login (real HOME and PATH). The "page" is a scripted stand-in with one WebMCP-style
 * tool, so the test checks the whole loop: ACP session, prompt, the agent finding the browser MCP
 * server, calling the page's tool, permission round trip, streamed answer, end of turn.
 */
import { afterAll, describe, expect, it } from "vitest";
import { pageContext } from "../../src/shared/context.js";
import type { FromBridge, HarnessInfo } from "../../src/shared/protocol.js";
import { FakeExtension } from "./hostHarness.js";

const harness = process.env.LIVE_HARNESS;
/** Timings and the answer, for whoever runs this by hand: LIVE_VERBOSE=1. */
const note = (...parts: unknown[]) => {
  if (process.env.LIVE_VERBOSE === "1") console.log(...parts);
};
const TURN_MS = Number(process.env.LIVE_TURN_MS ?? 240_000);

describe.skipIf(!harness)(`live turn with ${harness}`, () => {
  const ext = new FakeExtension({ PATH: process.env.PATH ?? "", BROWSER_HARNESS_FAKE_AGENT: "" });
  afterAll(() => ext.close());

  it(
    "answers from the page's own tool",
    async () => {
      const calls: string[] = [];
      ext.serveBrowserTools(
        [
          {
            name: "webmcp_list_tools",
            description: "List the WebMCP tools the active tab registered.",
            inputSchema: { type: "object", properties: {} }
          },
          {
            name: "webmcp_call_tool",
            description: "Call one of the active tab's WebMCP tools by name.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" }, arguments: { type: "object" } },
              required: ["name"]
            }
          }
        ],
        (name, args) => {
          calls.push(`${name} ${JSON.stringify(args)}`);
          if (name === "webmcp_list_tools")
            return JSON.stringify([
              {
                name: "getOrderStatus",
                description: "Status of the shopper's latest order.",
                inputSchema: { type: "object", properties: {} }
              }
            ]);
          return JSON.stringify({ order: "A-1042", status: "shipped", carrier: "PostNL", eta: "Saturday" });
        }
      );
      ext.onMessage((m) => {
        if (m.type === "permission.request") {
          const allow = m.options.find((o) => o.kind === "allow_once") ?? m.options[0];
          ext.post({ type: "permission.respond", requestId: m.requestId, optionId: allow?.optionId ?? null });
        }
      });

      await ext.request({ type: "hello", extensionVersion: "live" });
      const detected = await ext.request<{ found: HarnessInfo[] }>({ type: "detect" });
      note("found:", detected.found.map((h) => `${h.id} ${h.version} (${h.launch})`).join("; "));
      expect(detected.found.map((h) => h.id)).toContain(harness);

      const started = Date.now();
      await ext.request({ type: "session.new", chatId: "live", harnessId: harness, cwd: ext.workspace }, 180_000);
      const ready = (await ext.next((m) => m.type === "session.ready" && m.chatId === "live", 120_000, 0)) as Extract<
        FromBridge,
        { type: "session.ready" }
      >;
      note(
        `session ${ready.acpSessionId} in ${Date.now() - started} ms; modes: ${ready.modes.map((m) => m.id).join(", ")}`
      );

      const from = ext.received.length;
      const prompted = Date.now();
      await ext.request(
        {
          type: "session.prompt",
          chatId: "live",
          text: "Where is my latest order? Check the page I'm on.",
          // The same line the extension sends, so the live run tests its rules too.
          pageContext: pageContext({
            tabId: 1,
            title: "My account | Example Shop",
            url: "https://shop.example/account",
            origin: "https://shop.example",
            webmcpTools: ["getOrderStatus"],
            webmcpSource: "native"
          })
        },
        30_000
      );
      const ended = (await ext.next(
        (m) => m.type === "session.turnEnded" && m.chatId === "live",
        TURN_MS,
        from
      )) as Extract<FromBridge, { type: "session.turnEnded" }>;
      const updates = ext.received
        .slice(from)
        .filter((m): m is Extract<FromBridge, { type: "session.update" }> => m.type === "session.update");
      const text = updates
        .map((m) => m.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as { content: { type: string; text?: string } }).content)
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("");
      const kinds = [...new Set(updates.map((m) => m.update.sessionUpdate))];
      const firstText = ext.received
        .slice(from)
        .findIndex((m) => m.type === "session.update" && m.update.sessionUpdate === "agent_message_chunk");
      note(`turn ended (${ended.stopReason}${ended.error ? `: ${ended.error}` : ""}) in ${Date.now() - prompted} ms`);
      note("update kinds:", kinds.join(", "), "| first text at message", firstText);
      note("browser calls:", calls);
      note("answer:", text);

      expect(ended.stopReason).toBe("end_turn");
      expect(calls.some((c) => c.startsWith("webmcp_call_tool"))).toBe(true);
      expect(text.toLowerCase()).toContain("shipped");
    },
    TURN_MS + 150_000
  );
});
