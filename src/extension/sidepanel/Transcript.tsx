import { stripPageContext } from "../../shared/context.js";
import type { TabSummary } from "../../shared/panel.js";
import type { Chat, Item } from "../../shared/transcript.js";
import {
  approvalOutcomeWords,
  browserActionPhrase,
  browserToolName,
  duration,
  permissionOutcomeWords,
  pretty,
  stepTitle,
  stopWords,
  toolStatusWord,
  pageChanges,
  pageLine
} from "./format.js";
import { HarnessMark, Icon } from "./icons.js";
import { Markdown } from "./markdown.js";

type Step = Extract<Item, { kind: "tool" | "approval" }>;
type Block = { kind: "steps"; id: string; steps: Step[] } | Exclude<Item, { kind: "tool" | "approval" | "permission" }>;

/** Consecutive tool calls and browser approvals form one rail; harness permissions attach to their tool. */
export function blocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    if (item.kind === "permission") continue;
    if (item.kind === "tool" || item.kind === "approval") {
      const last = out.at(-1);
      if (last?.kind === "steps") last.steps.push(item);
      else out.push({ kind: "steps", id: `s-${item.id}`, steps: [item] });
      continue;
    }
    out.push(item);
  }
  return out;
}

export function Transcript({ chat, tab }: { chat: Chat; tab?: TabSummary | null }) {
  const pageChanged = pageChanges(chat.items);
  const permissions = chat.items.filter(
    (item): item is Extract<Item, { kind: "permission" }> => item.kind === "permission"
  );
  const toolCount = tab?.webmcpTools.length ?? 0;

  return (
    <div
      class="transcript"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={`Conversation with ${chat.harnessName}`}
    >
      {chat.items.length === 0 && chat.state === "starting" && (
        <div class="session-start">
          <p class="muted small">Starting a {chat.harnessName} session…</p>
        </div>
      )}
      {chat.items.length === 0 && chat.state === "idle" && (
        <div class="session-ready">
          <HarnessMark id={chat.harnessId} />
          <p class="session-ready-title">{chat.harnessName} is ready</p>
          <p class="muted small">
            {toolCount > 0
              ? `Wired to ${tab?.title || "this tab"} with ${toolCount} WebMCP tool${toolCount === 1 ? "" : "s"}. Ask what it can do or run an action.`
              : tab
                ? `Looking at ${tab.title || tab.url}. Ask about the page or give a task.`
                : "Open a tab or send a message to begin."}
          </p>
        </div>
      )}
      {blocks(chat.items).map((block) => {
        switch (block.kind) {
          case "user": {
            const page = pageChanged.has(block.id) ? block.page : null;
            return (
              <div key={block.id} class="msg-user">
                <span class="msg-text">{stripPageContext(block.text)}</span>
                {page !== null && (
                  <span class="msg-page" title={page}>
                    <Icon name="fetch" size={11} />
                    <span>On {pageLine(page)}</span>
                  </span>
                )}
              </div>
            );
          }
          case "agent":
            return (
              <div key={block.id} class="msg-agent">
                <Markdown text={block.text} />
              </div>
            );
          case "thought":
            return (
              <details key={block.id} class="thought">
                <summary>
                  {block.endedAt === null
                    ? "Thinking…"
                    : `Thought for ${duration(block.endedAt - block.startedAt) || "a moment"}`}
                </summary>
                <p>{block.text}</p>
              </details>
            );
          case "plan": {
            const doneCount = block.entries.filter((entry) => entry.status === "completed").length;
            return (
              <section key={block.id} class="plan" aria-label="Plan">
                <div class="plan-head">
                  <h3>Plan</h3>
                  <span class="plan-progress" aria-hidden="true">
                    {doneCount}/{block.entries.length}
                  </span>
                </div>
                <ol>
                  {block.entries.map((entry, index) => (
                    <li key={index} data-status={entry.status}>
                      <span class="plan-mark" aria-hidden="true">
                        {entry.status === "completed" && <Icon name="check" size={11} />}
                      </span>
                      <span class="plan-item-text">
                        {entry.content}
                        {entry.status === "in_progress" ? " (now)" : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            );
          }
          case "notice":
            return (
              <p
                key={block.id}
                class={`notice ${block.tone === "error" ? "error" : ""}`}
                role={block.tone === "error" ? "alert" : undefined}
              >
                {block.text}
              </p>
            );
          case "turn-end":
            return (
              <p key={block.id} class="turn-end">
                {stopWords(block.stopReason, block.durationMs)}
              </p>
            );
          case "steps":
            return (
              <ol key={block.id} class="steps" aria-label="Steps">
                {block.steps.map((step) =>
                  step.kind === "tool" ? (
                    <ToolStep key={step.id} step={step} permissions={permissions} />
                  ) : (
                    <ApprovalStep key={step.id} step={step} />
                  )
                )}
              </ol>
            );
        }
      })}
    </div>
  );
}

function ToolStep({
  step,
  permissions
}: {
  step: Extract<Item, { kind: "tool" }>;
  permissions: Extract<Item, { kind: "permission" }>[];
}) {
  const asks = permissions.filter((permission) => permission.toolCallId === step.id);
  const waiting = asks.some((permission) => permission.outcome === null);
  const took = step.endedAt === null ? "" : duration(step.endedAt - step.startedAt);
  const input = pretty(step.input);
  const isBrowser = Boolean(browserToolName(step.title));
  const iconName = step.toolKind !== "other" ? step.toolKind : isBrowser ? "fetch" : "execute";

  return (
    <li
      class="step"
      data-status={waiting ? "pending" : step.status}
      data-kind={step.toolKind}
      data-browser={isBrowser ? "" : undefined}
    >
      <details>
        <summary>
          <span class="glyph" aria-hidden="true">
            <Icon name={iconName} size={13} />
          </span>
          <span class="name" title={step.title}>
            {stepTitle(step.title, step.input)}
          </span>
          <span class="state">
            {toolStatusWord(step.status, waiting) + (took && step.status === "completed" ? `, ${took}` : "")}
          </span>
        </summary>
        <div class="detail">
          {input && (
            <div class="detail-block">
              <h4>Input</h4>
              <pre class="mono">{input}</pre>
            </div>
          )}
          {step.output && (
            <div class="detail-block">
              <h4>Output</h4>
              <pre class="mono">{step.output}</pre>
            </div>
          )}
          {!input && !step.output && <p class="muted small">No details yet.</p>}
        </div>
      </details>
      {asks
        .filter((permission) => permission.outcome !== null)
        .map((permission) => {
          const words = permissionOutcomeWords(permission.outcome!);
          return (
            <p key={permission.id} class={`decided ${words.allowed ? "" : "no"}`}>
              Asked first. <strong>{words.text}</strong>
            </p>
          );
        })}
    </li>
  );
}

function ApprovalStep({ step }: { step: Extract<Item, { kind: "approval" }> }) {
  const words = step.outcome ? approvalOutcomeWords(step.outcome, step.origin) : null;
  return (
    <li class="step" data-status={step.outcome === null ? "pending" : words?.allowed ? "completed" : "failed"}>
      <div class="line">
        <span class="glyph" aria-hidden="true">
          <Icon name="shield" size={13} />
        </span>
        <span class="name">Browser check: {browserActionPhrase(step.tool, step.args)}</span>
        <span class="state">{step.outcome === null ? "Needs you" : words!.allowed ? "Allowed" : "Not done"}</span>
      </div>
      {words && (
        <p class={`decided ${words.allowed ? "" : "no"}`}>
          {step.reason} <strong>{words.text}</strong>
        </p>
      )}
    </li>
  );
}
