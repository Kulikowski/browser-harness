/**
 * Where chats are kept between restarts. Each chat is its own record ("chat:<id>"), so a streamed
 * turn rewrites one chat rather than all of them, and writes are gathered into one per short while.
 * The service worker owns the chats themselves; this only knows which of them changed.
 */
import type { ActivityEntry } from "../../shared/panel.js";
import type { Chat } from "../../shared/transcript.js";

export const CHAT_PREFIX = "chat:";
export const ACTIVITY_KEY = "activity";
/** Where every chat used to live, as one array. Read once and split up. */
const LEGACY_CHATS = "chats";

/** The part of chrome.storage.local this needs. */
export interface StorageArea {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface ChatStoreOptions {
  storage: StorageArea;
  /** The chat as it is now, or undefined when it is gone. */
  chat(id: string): Chat | undefined;
  activity(): ActivityEntry[];
  /** Called after each save: with the error when it failed, with null when it went through. */
  saved(error: unknown): void;
  delayMs?: number;
}

export class ChatStore {
  private readonly changed = new Set<string>();
  private readonly deleted = new Set<string>();
  private activityChanged = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ChatStoreOptions) {}

  /** Everything stored: the chats, and the other records (settings, activity) as they are. */
  async load(): Promise<{ chats: Chat[]; rest: Record<string, unknown> }> {
    const stored = await this.options.storage.get(null);
    const legacy = Array.isArray(stored[LEGACY_CHATS]) ? (stored[LEGACY_CHATS] as Chat[]) : [];
    const own = Object.entries(stored)
      .filter(([key]) => key.startsWith(CHAT_PREFIX))
      .map(([, chat]) => chat as Chat);
    // A chat saved both ways was saved on its own later, so that copy wins.
    const known = new Set(own.map((chat) => chat.id));
    const moved = legacy.filter((chat) => !known.has(chat.id));
    if (LEGACY_CHATS in stored) {
      await this.options.storage.set(Object.fromEntries(moved.map((chat) => [CHAT_PREFIX + chat.id, chat])));
      await this.options.storage.remove([LEGACY_CHATS]);
    }
    const rest = Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== LEGACY_CHATS && !key.startsWith(CHAT_PREFIX))
    );
    return { chats: [...moved, ...own], rest };
  }

  chatChanged(id: string): void {
    this.deleted.delete(id);
    this.changed.add(id);
    this.schedule();
  }

  chatDeleted(id: string): void {
    this.changed.delete(id);
    this.deleted.add(id);
    this.schedule();
  }

  activityAdded(): void {
    this.activityChanged = true;
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.delayMs ?? 300);
  }

  /** Writes what changed since the last save. What a failed save was carrying waits for the next one. */
  async flush(): Promise<void> {
    const changed = [...this.changed];
    const deleted = [...this.deleted];
    const withActivity = this.activityChanged;
    this.changed.clear();
    this.deleted.clear();
    this.activityChanged = false;
    const records: Record<string, unknown> = {};
    for (const id of changed) {
      const chat = this.options.chat(id);
      if (chat) records[CHAT_PREFIX + id] = chat;
    }
    if (withActivity) records[ACTIVITY_KEY] = this.options.activity();
    try {
      if (Object.keys(records).length) await this.options.storage.set(records);
      if (deleted.length) await this.options.storage.remove(deleted.map((id) => CHAT_PREFIX + id));
      this.options.saved(null);
    } catch (error) {
      // Unless it changed again meanwhile, in which case the newer mark stands.
      for (const id of changed) if (!this.deleted.has(id)) this.changed.add(id);
      for (const id of deleted) if (!this.changed.has(id)) this.deleted.add(id);
      this.activityChanged ||= withActivity;
      this.options.saved(error);
    }
  }
}
