/**
 * What each chat's composer holds: the words being typed, a message waiting for the agent to be
 * free, and the last send error. It lives above the chat view, so switching to the chat list and
 * back keeps a draft and still delivers a queued message.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import { messageOf } from "../../shared/errors.js";
import type { Chat } from "../../shared/transcript.js";

export interface Outbox {
  draft: string;
  /** Written while the agent was starting or busy; sent as soon as it is free. */
  queued: string | null;
  error: string | null;
  /** A message is on its way and the chat has not shown it yet; the next one waits behind it. */
  sending: boolean;
}

export const EMPTY_OUTBOX: Outbox = { draft: "", queued: null, error: null, sending: false };

/** The agent cannot take a new message in these states, so one written now waits. */
export function isBusy(chat: Pick<Chat, "state">): boolean {
  return chat.state === "working" || chat.state === "waiting" || chat.state === "starting";
}

/** Words handed back to the composer (a cancelled or failed message) go in front of what is being typed. */
export function handBack(words: string, draft: string): string {
  return draft ? `${words}\n\n${draft}` : words;
}

/** A message written while another waits joins it, so the agent gets them together, in order. */
export function joinQueued(queued: string | null, words: string): string {
  return queued === null ? words : `${queued}\n\n${words}`;
}

/** What to do with a queued message now: send it, give it back, or keep waiting. */
export function queuedAction(chat: Pick<Chat, "state"> | undefined): "send" | "hand-back" | "drop" | "wait" {
  if (!chat) return "drop";
  if (chat.state === "idle") return "send";
  if (chat.state === "error" || chat.state === "closed") return "hand-back";
  return "wait";
}

export interface Outboxes {
  of(chatId: string): Outbox;
  setDraft(chatId: string, draft: string): void;
  /** Send the draft, or queue it when the agent is busy (or something is already queued). */
  submit(chat: Chat): void;
  /** Take the queued message back into the composer. */
  cancel(chatId: string): void;
}

export function useOutboxes(chats: readonly Chat[], send: (chatId: string, text: string) => Promise<void>): Outboxes {
  const [boxes, setBoxes] = useState<Readonly<Record<string, Outbox>>>({});

  const update = useCallback((chatId: string, change: (box: Outbox) => Outbox) => {
    setBoxes((all) => ({ ...all, [chatId]: change(all[chatId] ?? EMPTY_OUTBOX) }));
  }, []);

  const deliver = useCallback(
    (chatId: string, text: string) => {
      update(chatId, (box) => ({ ...box, error: null, sending: true }));
      send(chatId, text).then(
        () => update(chatId, (box) => ({ ...box, sending: false })),
        (failure: unknown) =>
          update(chatId, (box) => ({
            ...box,
            sending: false,
            draft: handBack(text, box.draft),
            error: messageOf(failure)
          }))
      );
    },
    [send, update]
  );

  // Deliver queued messages once their agent is free; give them back if it never will be.
  useEffect(() => {
    for (const [chatId, box] of Object.entries(boxes)) {
      if (box.queued === null || box.sending) continue;
      const words = box.queued;
      const action = queuedAction(chats.find((chat) => chat.id === chatId));
      if (action === "wait") continue;
      if (action === "drop") {
        setBoxes(({ [chatId]: _gone, ...rest }) => rest);
      } else if (action === "hand-back") {
        update(chatId, (current) => ({ ...current, queued: null, draft: handBack(words, current.draft) }));
      } else {
        update(chatId, (current) => ({ ...current, queued: null }));
        deliver(chatId, words);
      }
    }
  }, [chats, boxes, update, deliver]);

  return {
    of: (chatId) => boxes[chatId] ?? EMPTY_OUTBOX,
    setDraft: (chatId, draft) => update(chatId, (box) => ({ ...box, draft })),
    submit: (chat) => {
      const box = boxes[chat.id] ?? EMPTY_OUTBOX;
      const words = box.draft.trim();
      if (!words) return;
      if (isBusy(chat) || box.queued !== null || box.sending) {
        update(chat.id, (current) => ({ ...current, draft: "", queued: joinQueued(current.queued, words) }));
        return;
      }
      update(chat.id, (current) => ({ ...current, draft: "" }));
      deliver(chat.id, words);
    },
    cancel: (chatId) =>
      update(chatId, (box) =>
        box.queued === null ? box : { ...box, queued: null, draft: handBack(box.queued, box.draft) }
      )
  };
}
