import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PanelRequest, PanelState } from "../../shared/panel.js";
import type { Chat } from "../../shared/transcript.js";
import { PanelClient } from "./client.js";
import { Dock, type DockActions } from "./Dock.js";
import { BrandMark, HarnessMark, Icon } from "./icons.js";
import { PageLine } from "./PageLine.js";
import { Activity, ChatList, NewChat, Setup, SignInNotice } from "./Pages.js";
import { useOutboxes, type Outboxes } from "./outbox.js";
import { Transcript } from "./Transcript.js";

type View = "chat" | "chats" | "new" | "activity";
const NO_CHATS: readonly Chat[] = [];
const SELECTED = "browser-harness:selected";

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(SELECTED));
  const [view, setView] = useState<View>("chat");
  const client = useMemo(() => new PanelClient(setState), []);
  const request = useCallback(<T,>(req: PanelRequest) => client.request<T>(req), [client]);
  const send = useCallback(
    async (chatId: string, text: string) => void (await client.request({ type: "chat.send", chatId, text })),
    [client]
  );
  const outboxes = useOutboxes(state?.chats ?? NO_CHATS, send);

  useEffect(() => {
    if (selected) localStorage.setItem(SELECTED, selected);
  }, [selected]);

  if (!state) return <div class="page muted small">Loading…</div>;
  if (state.bridge.state !== "connected") {
    return (
      <div class="shell">
        <main class="scroll">
          <Setup state={state} request={request} />
        </main>
      </div>
    );
  }

  const chat = state.chats.find((entry) => entry.id === selected) ?? null;
  const effectiveView: View = view === "chat" && !chat ? (state.chats.length ? "chats" : "new") : view;
  const open = (chatId: string) => {
    setSelected(chatId);
    setView("chat");
  };

  return (
    <div class="shell">
      <header class="top">
        <div class="top-bar">
          {effectiveView === "chat" && chat ? (
            <button
              type="button"
              class="top-title"
              onClick={() => setView("chats")}
              aria-label={`${chat.title}. Show all chats`}
            >
              <HarnessMark id={chat.harnessId} />
              <span class="top-title-text">{chat.title}</span>
              <span class="top-chevron" aria-hidden="true">
                <Icon name="chevron" size={13} />
              </span>
            </button>
          ) : (
            <div class="top-heading-wrap">
              {effectiveView === "new" ? (
                <span class="tile-mark brand-tile" aria-hidden="true">
                  <Icon name="plus" size={13} />
                </span>
              ) : (
                <BrandMark />
              )}
              <h1 class="top-heading">
                {effectiveView === "chats" ? "Chats" : effectiveView === "activity" ? "Browser activity" : "New chat"}
              </h1>
            </div>
          )}
          <div class="top-actions">
            {effectiveView === "chat" && chat && (
              <button type="button" class="btn btn-sm" onClick={() => setView("new")}>
                <Icon name="plus" size={12} />
                <span>New chat</span>
              </button>
            )}
            {effectiveView === "new" && (
              <>
                {chat && (
                  <button type="button" class="btn quiet btn-sm" onClick={() => setView("chat")}>
                    <Icon name="back" size={12} />
                    <span>Back to chat</span>
                  </button>
                )}
                <button type="button" class="btn quiet btn-sm" onClick={() => setView("chats")}>
                  <Icon name="sliders" size={12} />
                  <span>{state.chats.length ? "Chats and settings" : "Settings"}</span>
                </button>
              </>
            )}
            {effectiveView === "chats" && (
              <>
                {chat && (
                  <button type="button" class="btn quiet btn-sm" onClick={() => setView("chat")}>
                    <Icon name="back" size={12} />
                    <span>Back to chat</span>
                  </button>
                )}
                <button type="button" class="btn btn-sm" onClick={() => setView("new")}>
                  <Icon name="plus" size={12} />
                  <span>New chat</span>
                </button>
              </>
            )}
            {effectiveView === "activity" && (
              <button type="button" class="btn quiet btn-sm" onClick={() => setView("chats")}>
                <Icon name="back" size={12} />
                <span>Back</span>
              </button>
            )}
          </div>
        </div>
        {effectiveView === "chat" && <PageLine tab={state.tab} pageToolsOnly={state.pageToolsOnly} />}
        {state.storageError && (
          <p class="notice error small" role="alert">
            {state.storageError}
          </p>
        )}
      </header>

      {effectiveView === "chat" && chat ? (
        <ChatView key={chat.id} state={state} chatId={chat.id} request={request} outboxes={outboxes} />
      ) : (
        <main class="scroll">
          {effectiveView === "new" && <NewChat state={state} request={request} onCreated={open} />}
          {effectiveView === "chats" && (
            <ChatList state={state} request={request} onOpen={open} onActivity={() => setView("activity")} />
          )}
          {effectiveView === "activity" && <Activity state={state} />}
        </main>
      )}
    </div>
  );
}

function ChatView({
  state,
  chatId,
  request,
  outboxes
}: {
  state: PanelState;
  chatId: string;
  request: <T>(req: PanelRequest) => Promise<T>;
  outboxes: Outboxes;
}) {
  const chat = state.chats.find((entry) => entry.id === chatId)!;
  const scrollerRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef(true);

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  });

  const actions: DockActions = {
    setDraft: (text) => outboxes.setDraft(chatId, text),
    submit: () => {
      pinnedRef.current = true;
      outboxes.submit(chat);
    },
    cancelQueued: () => outboxes.cancel(chatId),
    stop: () => {
      // Stopping means "not now": a queued message comes back to the composer instead of going out.
      outboxes.cancel(chatId);
      void request({ type: "chat.cancel", chatId });
    },
    setMode: (modeId) => request({ type: "chat.setMode", chatId, modeId }),
    answerPermission: (requestId, optionId) => void request({ type: "permission.answer", chatId, requestId, optionId }),
    answerApproval: (id, outcome) => void request({ type: "approval.answer", chatId, id, outcome })
  };

  const signIn = state.signIn[chat.harnessId];
  return (
    <>
      <main
        class="scroll"
        ref={scrollerRef}
        onScroll={(event) => {
          const element = event.currentTarget as HTMLElement;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        <Transcript chat={chat} tab={state.tab} />
        {signIn && signIn.methods.length > 0 && (
          <div class="transcript" style={{ paddingTop: 0 }}>
            <SignInNotice
              state={state}
              request={request}
              harnessId={chat.harnessId}
              message={`${chat.harnessName} needs you to sign in, with its own login. Do it in its terminal, or start it here, then send again.`}
            />
          </div>
        )}
      </main>
      <Dock chat={chat} box={outboxes.of(chatId)} actions={actions} />
    </>
  );
}
