import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SessionInfo } from "../../shared/acp.js";
import type { ActivityEntry, PanelState } from "../../shared/panel.js";
import type { HarnessId, SessionListData } from "../../shared/protocol.js";
import { chatStateWord, duration, messageOf, middleEllipsis, relativeTime, tildePath } from "./format.js";
import { HarnessMark, Icon } from "./icons.js";

/** How much of an agent's install path fits beside its version in the picker. */
const HARNESS_PATH_CHARS = 32;

const ACTIVITY_WORDS: Record<ActivityEntry["outcome"], string> = {
  done: "Done",
  failed: "Failed",
  denied: "Declined",
  blocked: "Blocked by Page tools only"
};

type Request = <T = unknown>(request: import("../../shared/panel.js").PanelRequest) => Promise<T>;

export function Setup({ state, request }: { state: PanelState; request: Request }) {
  const bridge = state.bridge;
  if (bridge.state === "connecting") {
    return (
      <div class="page">
        <div class="session-start">
          <p class="muted small">Connecting to the bridge on this computer…</p>
        </div>
      </div>
    );
  }
  const detail = bridge.state === "not-installed" || bridge.state === "failed" ? bridge.detail : "";
  return (
    <div class="page">
      <div class="pane-section">
        <h3>Connect the bridge</h3>
        <p class="muted small">
          The extension talks to the coding agents on this computer through a small local program. It holds no API keys;
          each agent uses the sign-in it already has.
        </p>
        <ol class="steps-howto">
          <li>
            In the extension's folder, run:
            <pre class="mono">npm install{"\n"}npm run install-host</pre>
          </li>
          <li>Come back here and choose Try again.</li>
        </ol>
        {detail && <p class="notice small">Chrome said: {detail}</p>}
        <div class="inline">
          <button type="button" class="btn btn-sm primary" onClick={() => void request({ type: "harness.refresh" })}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewChat({
  state,
  request,
  onCreated
}: {
  state: PanelState;
  request: Request;
  onCreated(chatId: string): void;
}) {
  const [error, setError] = useState<{ harnessId: HarnessId; message: string } | null>(null);
  const [busy, setBusy] = useState<HarnessId | null>(null);
  const start = async (harnessId: HarnessId) => {
    setBusy(harnessId);
    setError(null);
    try {
      onCreated(await request<string>({ type: "chat.new", harnessId }));
    } catch (failure) {
      setError({ harnessId, message: messageOf(failure) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="page">
      <p class="muted small">
        Each chat is its own session in the agent you pick, working in{" "}
        <code class="inline-path" title={state.cwd}>
          {middleEllipsis(tildePath(state.cwd), 36) || "its own folder"}
        </code>
        .
      </p>
      {state.harnesses.length === 0 ? (
        <div class="empty">
          <h3>No coding agent found</h3>
          <p class="small">Install one of these, sign in once in its own terminal UI, then choose Look again.</p>
          <button type="button" class="btn btn-sm" onClick={() => void request({ type: "harness.refresh" })}>
            <Icon name="refresh" size={12} />
            <span>Look again</span>
          </button>
        </div>
      ) : (
        <section class="pane-section">
          <div class="list-head">
            <p class="section-label" aria-hidden="true">
              On this computer
            </p>
            <button type="button" class="btn quiet btn-xs" onClick={() => void request({ type: "harness.refresh" })}>
              <Icon name="refresh" size={12} />
              <span>Look again</span>
            </button>
          </div>
          <ul class="list" aria-label="Agents on this computer">
            {state.harnesses.map((harness) => (
              <li key={harness.id}>
                <button
                  type="button"
                  class="row harness-row"
                  disabled={busy !== null}
                  onClick={() => void start(harness.id)}
                >
                  <HarnessMark id={harness.id} />
                  <span class="row-body">
                    <span class="title">{harness.name}</span>{" "}
                    <span class="sub" title={`${harness.foundAt}\nRuns: ${harness.launch}`}>
                      {harness.version && <span class="ver-pill">{harness.version}</span>}
                      {harness.version ? " " : ""}
                      <span class="path-text">{middleEllipsis(tildePath(harness.foundAt), HARNESS_PATH_CHARS)}</span>
                    </span>
                  </span>
                  <span class="tag start">{busy === harness.id ? "Starting…" : "Start"}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <SignInNotice state={state} request={request} harnessId={error.harnessId} message={error.message} />}
      {state.missing.length > 0 && (
        <details class="missing-box">
          <summary>
            {state.missing.length} more {state.missing.length === 1 ? "agent" : "agents"} not installed
          </summary>
          <ul class="missing-list">
            {state.missing.map((entry) => (
              <li key={entry.id}>
                <span class="missing-name">{entry.name}</span>
                <code>{entry.installHint}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SignInNotice({
  state,
  request,
  message,
  harnessId: only
}: {
  state: PanelState;
  request: Request;
  message: string;
  harnessId?: HarnessId;
}) {
  const entries = (
    Object.entries(state.signIn) as [HarnessId, { message: string; methods: { id: string; name: string }[] }][]
  ).filter(([id]) => !only || id === only);
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div class="notice error signin-notice" role="alert">
      <p class="signin-msg">{message}</p>
      {entries.flatMap(([harnessId, info]) =>
        info.methods.map((method) => (
          <div key={`${harnessId}-${method.id}`} class="signin-method">
            <button
              type="button"
              class="btn btn-sm"
              onClick={async () => {
                setStatus(`Opening ${method.name}…`);
                try {
                  await request({ type: "harness.signIn", harnessId, methodId: method.id });
                  setStatus("Signed in. Start the chat again.");
                } catch (failure) {
                  setStatus(messageOf(failure));
                }
              }}
            >
              {method.name}
            </button>
            <span class="small muted">uses the agent's own sign-in, no key</span>
          </div>
        ))
      )}
      {status && <p class="small signin-status">{status}</p>}
    </div>
  );
}

/**
 * A button that deletes on the second click: the first one turns it into the question. Looking away
 * (blur) or waiting takes the question back, so a stray click deletes nothing.
 */
function ConfirmButton({
  label,
  question,
  children,
  onConfirm
}: {
  /** What the button does, for screen readers and the tooltip. */
  label: string;
  question: string;
  children: ComponentChildren;
  onConfirm(): void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      class={`btn btn-xs quiet ${armed ? "reject" : ""}`}
      aria-label={armed ? question : label}
      title={armed ? undefined : label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? question : children}
    </button>
  );
}

/** The current time, refreshed every half minute, for "5 min ago" labels. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function ChatList({
  state,
  request,
  onOpen,
  onActivity
}: {
  state: PanelState;
  request: Request;
  onOpen(chatId: string): void;
  onActivity(): void;
}) {
  const now = useNow();
  return (
    <div class="page">
      <section class="pane-section">
        <div class="list-head">
          <p class="section-label" aria-hidden="true">
            Sessions in this panel
          </p>
          {state.chats.length > 1 && (
            <ConfirmButton
              label="Clear all chats from this panel"
              question={`Delete all ${state.chats.length}?`}
              onConfirm={() => {
                for (const chat of state.chats) void request({ type: "chat.delete", chatId: chat.id });
              }}
            >
              Clear all
            </ConfirmButton>
          )}
        </div>
        {state.chats.length === 0 ? (
          <p class="muted small">No chats yet. Start one, and it gets its own session in the agent you choose.</p>
        ) : (
          <ul class="list" aria-label="Chats">
            {state.chats.map((chat) => {
              const word = chatStateWord(chat);
              return (
                <li key={chat.id} class="chat-item">
                  <button type="button" class="row chat-row" onClick={() => onOpen(chat.id)}>
                    <HarnessMark id={chat.harnessId} />
                    <span class="row-body">
                      <span class="title">{chat.title}</span>{" "}
                      <span class="sub">
                        {chat.harnessName}, {relativeTime(chat.updatedAt, now)}
                      </span>
                    </span>
                    {word && (
                      <span
                        class={`tag ${chat.state === "waiting" ? "needs" : chat.state === "working" ? "working" : ""}`}
                      >
                        {word}
                      </span>
                    )}
                  </button>
                  <ConfirmButton
                    label={`Delete chat: ${chat.title}`}
                    question="Delete?"
                    onConfirm={() => void request({ type: "chat.delete", chatId: chat.id })}
                  >
                    <Icon name="delete" size={13} />
                  </ConfirmButton>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <HarnessSessions state={state} request={request} onOpen={onOpen} />
      <PageToolsOnly state={state} request={request} />
      <Folder state={state} request={request} />

      <section class="pane-section">
        <button type="button" class="row nav-row" onClick={onActivity}>
          <span class="tile-mark nav-tile" aria-hidden="true">
            <Icon name="activity" size={13} />
          </span>
          <span class="row-body">
            <span class="title">Browser activity ({state.activity.length})</span>
            <span class="sub">Every browser tool run through this extension</span>
          </span>
          <span class="nav-chevron" aria-hidden="true">
            <Icon name="arrow" size={13} />
          </span>
        </button>
      </section>
    </div>
  );
}

function HarnessSessions({
  state,
  request,
  onOpen
}: {
  state: PanelState;
  request: Request;
  onOpen(chatId: string): void;
}) {
  const [shown, setShown] = useState<{ harnessId: HarnessId; data: SessionListData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  if (state.harnesses.length === 0) return null;
  const known = new Set(state.chats.map((chat) => chat.acpSessionId));
  return (
    <section class="pane-section">
      <div class="section-head">
        <h3>Sessions started elsewhere</h3>
        <p class="muted small">Open a session you began in the agent's own terminal UI. Its history comes along.</p>
      </div>
      <div class="inline">
        {state.harnesses.map((harness) => (
          <button
            key={harness.id}
            type="button"
            class={`btn btn-sm ${shown?.harnessId === harness.id ? "is-selected" : ""}`}
            onClick={async () => {
              setError(null);
              try {
                setShown({
                  harnessId: harness.id,
                  data: await request<SessionListData>({ type: "sessions.list", harnessId: harness.id })
                });
              } catch (failure) {
                setError(messageOf(failure));
              }
            }}
          >
            {harness.name}
          </button>
        ))}
      </div>
      {error && <p class="notice error small">{error}</p>}
      {shown && !shown.data.supported && <p class="small muted">This agent cannot list its sessions over ACP.</p>}
      {shown?.data.supported && (
        <ul class="list" aria-label="Sessions">
          {shown.data.sessions.length === 0 && <li class="empty-inline small muted">None yet.</li>}
          {shown.data.sessions.map((session: SessionInfo) => (
            <li key={session.sessionId}>
              <button
                type="button"
                class="row session-row"
                onClick={async () => {
                  try {
                    onOpen(await request<string>({ type: "sessions.open", harnessId: shown.harnessId, session }));
                  } catch (failure) {
                    setError(messageOf(failure));
                  }
                }}
              >
                <HarnessMark id={shown.harnessId} />
                <span class="row-body">
                  <span class="title">{session.title || session.sessionId}</span>{" "}
                  <span class="sub">
                    {tildePath(session.cwd)}
                    {session.updatedAt ? `, ${relativeTime(Date.parse(session.updatedAt), now)}` : ""}
                  </span>
                </span>
                <span class="tag">{known.has(session.sessionId) ? "Open" : "Bring in"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PageToolsOnly({ state, request }: { state: PanelState; request: Request }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section class="pane-section">
      <h3>Reading and clicking pages</h3>
      <label class="switch">
        <input
          type="checkbox"
          checked={state.pageToolsOnly}
          onChange={(event) => {
            setError(null);
            request({ type: "settings.pageToolsOnly", on: (event.target as HTMLInputElement).checked }).catch(
              (failure: unknown) => setError(messageOf(failure))
            );
          }}
        />
        <span>
          <strong>Page tools only</strong>
          <span class="muted small">
            The agent uses only the tools a page offers through WebMCP. It can't read, click or type on pages, so pages
            without WebMCP are off limits.
          </span>
        </span>
      </label>
      {error && <p class="small notice error">{error}</p>}
    </section>
  );
}

function Folder({ state, request }: { state: PanelState; request: Request }) {
  const [value, setValue] = useState(state.cwd);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section class="pane-section field">
      <h3>
        <label for="cwd">Folder for new chats</label>
      </h3>
      <p class="muted small">
        The agent's working folder. Point it at a project if you want it to read or edit code there.
      </p>
      <form
        class="folder-form"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await request({ type: "settings.cwd", cwd: value });
            setMessage("Saved. New chats use it.");
          } catch (failure) {
            setMessage(messageOf(failure));
          }
        }}
      >
        <input
          id="cwd"
          value={value}
          onInput={(event) => setValue((event.target as HTMLInputElement).value)}
          spellcheck={false}
        />
        <button type="submit" class="btn btn-sm">
          Save
        </button>
      </form>
      {message && <p class="small save-note">{message}</p>}
    </section>
  );
}

export function Activity({ state }: { state: PanelState }) {
  const names = new Map(state.chats.map((chat) => [chat.id, chat.title]));
  return (
    <div class="page">
      <p class="muted small">Every browser tool an agent ran through this extension, newest first.</p>
      {state.activity.length === 0 ? (
        <p class="muted small">Nothing yet.</p>
      ) : (
        <div class="table-wrap">
          <table class="activity">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Agent</th>
                <th scope="col">Tool</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {state.activity.map((entry, index) => (
                <tr key={index}>
                  <td class="tabular">
                    {new Date(entry.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    })}
                  </td>
                  <td title={entry.chatId ? names.get(entry.chatId) : undefined}>{entry.harness}</td>
                  <td>
                    <code class="tool-chip">{entry.tool}</code>
                  </td>
                  <td class={`tabular ${entry.outcome === "done" ? "" : entry.outcome}`}>
                    {ACTIVITY_WORDS[entry.outcome]}, {duration(entry.ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
