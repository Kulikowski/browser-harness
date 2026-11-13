/**
 * A chat as the side panel shows it, built by folding events. Pure, so the service worker (which
 * stores chats) and the panel (which draws them) agree, and tests can replay a session.
 */
import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionMode,
  SessionUpdate,
  StopReason,
  ToolCallFields,
  ToolCallStatus,
  ToolKind
} from "./acp.js";
import type { ApprovalCategory } from "./policy.js";
import { stripPageContext } from "./context.js";
import type { HarnessId } from "./protocol.js";

export type ChatState = "starting" | "idle" | "working" | "waiting" | "error" | "closed";

export type PermissionOutcome = { optionId: string; name: string; kind: PermissionOption["kind"] } | "cancelled";
export type ApprovalOutcome = "allowed" | "always" | "denied" | "expired";

export type Item =
  | { kind: "user"; id: string; text: string; at: number; page: string | null }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string; startedAt: number; endedAt: number | null }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      input: unknown;
      output: string;
      startedAt: number;
      endedAt: number | null;
    }
  | {
      kind: "permission";
      id: string;
      toolCallId: string;
      title: string;
      input: unknown;
      options: PermissionOption[];
      outcome: PermissionOutcome | null;
    }
  | {
      kind: "approval";
      id: string;
      tool: string;
      args: Record<string, unknown>;
      origin: string;
      reason: string;
      category: ApprovalCategory;
      outcome: ApprovalOutcome | null;
    }
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "notice"; id: string; tone: "info" | "error"; text: string }
  | { kind: "turn-end"; id: string; stopReason: StopReason | "error"; durationMs: number | null };

export interface Chat {
  id: string;
  harnessId: HarnessId;
  harnessName: string;
  acpSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  state: ChatState;
  modes: SessionMode[];
  currentModeId: string | null;
  turnStartedAt: number | null;
  items: Item[];
}

export type ChatEvent =
  | { type: "ready"; acpSessionId: string; modes: SessionMode[]; currentModeId: string | null; replayed: boolean }
  | { type: "prompt"; id: string; text: string; page: string | null }
  | { type: "update"; update: SessionUpdate; replay: boolean }
  | { type: "permission"; requestId: string; toolCall: ToolCallFields; options: PermissionOption[] }
  | { type: "permission-resolved"; requestId: string; outcome: PermissionOutcome }
  | {
      type: "approval";
      id: string;
      tool: string;
      args: Record<string, unknown>;
      origin: string;
      reason: string;
      category: ApprovalCategory;
    }
  | { type: "approval-resolved"; id: string; outcome: ApprovalOutcome }
  | { type: "turn-ended"; stopReason: StopReason | "error"; error?: string }
  | { type: "error"; text: string }
  | { type: "closed"; reason: string }
  | { type: "reset-for-replay" };

export function newChat(init: {
  id: string;
  harnessId: HarnessId;
  harnessName: string;
  cwd: string;
  now: number;
}): Chat {
  return {
    id: init.id,
    harnessId: init.harnessId,
    harnessName: init.harnessName,
    acpSessionId: null,
    title: "New chat",
    cwd: init.cwd,
    createdAt: init.now,
    updatedAt: init.now,
    state: "starting",
    modes: [],
    currentModeId: null,
    turnStartedAt: null,
    items: []
  };
}

const TITLE_LENGTH = 60;

export function applyEvent(chat: Chat, event: ChatEvent, now: number): Chat {
  const next: Chat = { ...chat, updatedAt: now };
  switch (event.type) {
    case "ready":
      return {
        ...next,
        acpSessionId: event.acpSessionId,
        modes: event.modes,
        currentModeId: event.currentModeId,
        state: hasPending(next.items) ? "waiting" : "idle"
      };
    case "reset-for-replay":
      // session/load replays the whole history; start from an empty transcript so nothing doubles.
      return { ...next, items: [] };
    case "prompt": {
      const title = chat.items.some((item) => item.kind === "user") ? chat.title : clipTitle(event.text);
      return {
        ...next,
        title,
        state: "working",
        turnStartedAt: now,
        items: [
          ...closeThoughts(chat.items, now),
          { kind: "user", id: event.id, text: event.text, at: now, page: event.page }
        ]
      };
    }
    case "update":
      return applyUpdate(next, event.update, now, event.replay);
    case "permission": {
      const tool = event.toolCall;
      const item: Item = {
        kind: "permission",
        id: event.requestId,
        toolCallId: tool.toolCallId,
        title: tool.title ?? "Run a tool",
        input: tool.rawInput ?? null,
        options: event.options,
        outcome: null
      };
      return { ...next, state: "waiting", items: [...upsertTool(chat.items, tool, now), item] };
    }
    case "permission-resolved":
      return settleWaiting({
        ...next,
        items: chat.items.map((item) =>
          item.kind === "permission" && item.id === event.requestId && item.outcome === null
            ? { ...item, outcome: event.outcome }
            : item
        )
      });
    case "approval":
      return {
        ...next,
        state: "waiting",
        items: [
          ...chat.items,
          {
            kind: "approval",
            id: event.id,
            tool: event.tool,
            args: event.args,
            origin: event.origin,
            reason: event.reason,
            category: event.category,
            outcome: null
          }
        ]
      };
    case "approval-resolved":
      return settleWaiting({
        ...next,
        items: chat.items.map((item) =>
          item.kind === "approval" && item.id === event.id && item.outcome === null
            ? { ...item, outcome: event.outcome }
            : item
        )
      });
    case "turn-ended": {
      const items = closeThoughts(chat.items, now).map((item): Item => {
        if (item.kind === "permission" && item.outcome === null) return { ...item, outcome: "cancelled" };
        if (item.kind === "approval" && item.outcome === null) return { ...item, outcome: "expired" };
        if (
          item.kind === "tool" &&
          (item.status === "pending" || item.status === "in_progress") &&
          event.stopReason === "cancelled"
        ) {
          return { ...item, status: "failed", endedAt: now };
        }
        return item;
      });
      const durationMs = chat.turnStartedAt === null ? null : now - chat.turnStartedAt;
      items.push({ kind: "turn-end", id: `end-${now}-${items.length}`, stopReason: event.stopReason, durationMs });
      if (event.error)
        items.push({ kind: "notice", id: `err-${now}-${items.length}`, tone: "error", text: event.error });
      return { ...next, state: "idle", turnStartedAt: null, items };
    }
    case "error":
      return {
        ...next,
        state: "error",
        items: [
          ...chat.items,
          { kind: "notice", id: `err-${now}-${chat.items.length}`, tone: "error", text: event.text }
        ]
      };
    case "closed":
      return {
        ...next,
        state: "closed",
        turnStartedAt: null,
        // Nothing can answer these any more; left open they would keep the chat "waiting" forever.
        items: [
          ...closeThoughts(chat.items, now).map((item): Item => {
            if (item.kind === "permission" && item.outcome === null) return { ...item, outcome: "cancelled" };
            if (item.kind === "approval" && item.outcome === null) return { ...item, outcome: "expired" };
            return item;
          }),
          { kind: "notice", id: `closed-${now}`, tone: "info", text: event.reason }
        ]
      };
  }
}

function applyUpdate(chat: Chat, update: SessionUpdate, now: number, replay: boolean): Chat {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf((update as { content: ContentBlock }).content);
      if (!text) return chat;
      const items = closeThoughts(chat.items, now);
      const last = items.at(-1);
      if (last?.kind === "agent") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "agent", id: `a-${now}-${items.length}`, text });
      return { ...chat, items };
    }
    case "agent_thought_chunk": {
      const text = textOf((update as { content: ContentBlock }).content);
      if (!text) return chat;
      const items = [...chat.items];
      const last = items.at(-1);
      if (last?.kind === "thought" && last.endedAt === null)
        items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "thought", id: `t-${now}-${items.length}`, text, startedAt: now, endedAt: null });
      return { ...chat, items };
    }
    case "user_message_chunk": {
      // Only history replay sends these; live prompts are already in the transcript.
      if (!replay) return chat;
      const text = textOf((update as { content: ContentBlock }).content);
      if (!text) return chat;
      const items = [...chat.items];
      const last = items.at(-1);
      // Kept as sent; the panel shows it through stripPageContext, so a tab line split across chunks still comes off.
      if (last?.kind === "user") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "user", id: `u-${now}-${items.length}`, text, at: now, page: null });
      const shown = items.at(-1) as Extract<Item, { kind: "user" }>;
      const title = chat.title === "New chat" ? clipTitle(shown.text) : chat.title;
      return { ...chat, title, items };
    }
    case "tool_call":
    case "tool_call_update":
      return { ...chat, items: upsertTool(closeThoughts(chat.items, now), update as ToolCallFields, now) };
    case "plan": {
      const entries = (update as { entries: PlanEntry[] }).entries;
      const items = [...chat.items];
      const index = findLastIndex(items, (item) => item.kind === "plan");
      // A plan update replaces the whole plan (ACP: "the complete list").
      if (index >= 0 && !items.slice(index + 1).some((item) => item.kind === "user"))
        items[index] = { kind: "plan", id: items[index]!.id, entries };
      else items.push({ kind: "plan", id: `p-${now}-${items.length}`, entries });
      return { ...chat, items };
    }
    case "session_info_update": {
      const title = (update as { title?: string | null }).title;
      return title ? { ...chat, title: clipTitle(title) } : chat;
    }
    case "current_mode_update":
      return { ...chat, currentModeId: (update as { currentModeId: string }).currentModeId };
    default:
      return chat;
  }
}

function upsertTool(items: Item[], fields: ToolCallFields, now: number): Item[] {
  const index = findLastIndex(items, (item) => item.kind === "tool" && item.id === fields.toolCallId);
  const output = summariseToolContent(fields);
  if (index < 0) {
    return [
      ...items,
      {
        kind: "tool",
        id: fields.toolCallId,
        title: fields.title ?? "Tool",
        toolKind: fields.kind ?? "other",
        status: fields.status ?? "pending",
        input: fields.rawInput ?? null,
        output: output ?? "",
        startedAt: now,
        endedAt: isFinal(fields.status) ? now : null
      }
    ];
  }
  const current = items[index] as Extract<Item, { kind: "tool" }>;
  const status = fields.status ?? current.status;
  const updated: Item = {
    ...current,
    title: fields.title ?? current.title,
    toolKind: fields.kind ?? current.toolKind,
    status,
    input: fields.rawInput ?? current.input,
    output: output ?? current.output,
    endedAt: isFinal(status) ? (current.endedAt ?? now) : null
  };
  const copy = [...items];
  copy[index] = updated;
  return copy;
}

function isFinal(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

const OUTPUT_LIMIT = 4000;

function summariseToolContent(fields: ToolCallFields): string | null {
  if (fields.content && fields.content.length > 0) {
    const parts = fields.content.map((entry) => {
      if (entry.type === "content")
        return (
          textOf((entry as { content: ContentBlock }).content) ||
          `[${(entry as { content: ContentBlock }).content.type}]`
        );
      if (entry.type === "diff") return `Edited ${(entry as { path: string }).path}`;
      if (entry.type === "terminal") return "Terminal output";
      return "";
    });
    return clip(parts.filter(Boolean).join("\n"), OUTPUT_LIMIT);
  }
  if (fields.rawOutput !== undefined && fields.rawOutput !== null) {
    return clip(
      typeof fields.rawOutput === "string" ? fields.rawOutput : JSON.stringify(fields.rawOutput, null, 2),
      OUTPUT_LIMIT
    );
  }
  return null;
}

function textOf(block: ContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return (block as { text: string }).text;
  if (block.type === "resource_link") return (block as { uri: string }).uri;
  return "";
}

function closeThoughts(items: Item[], now: number): Item[] {
  return items.map((item) => (item.kind === "thought" && item.endedAt === null ? { ...item, endedAt: now } : item));
}

function hasPending(items: Item[]): boolean {
  return items.some((item) => (item.kind === "permission" || item.kind === "approval") && item.outcome === null);
}

function settleWaiting(chat: Chat): Chat {
  if (chat.state !== "waiting" || hasPending(chat.items)) return chat;
  return { ...chat, state: chat.turnStartedAt === null ? "idle" : "working" };
}

export function pendingDecisions(chat: Chat): Extract<Item, { kind: "permission" | "approval" }>[] {
  return chat.items.filter(
    (item): item is Extract<Item, { kind: "permission" | "approval" }> =>
      (item.kind === "permission" || item.kind === "approval") && item.outcome === null
  );
}

function clipTitle(text: string): string {
  const oneLine = stripPageContext(text.replace(/\s+/g, " ").trim());
  return oneLine.length > TITLE_LENGTH ? `${oneLine.slice(0, TITLE_LENGTH - 1)}…` : oneLine || "New chat";
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i;
  return -1;
}
