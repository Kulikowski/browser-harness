import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_KEY, CHAT_PREFIX, ChatStore, type StorageArea } from "../../src/extension/background/chatStore.js";
import type { ActivityEntry } from "../../src/shared/panel.js";
import { newChat, type Chat } from "../../src/shared/transcript.js";

const chat = (id: string, title = id): Chat => ({
  ...newChat({ id, harnessId: "fake", harnessName: "Scripted", cwd: "/tmp/w", now: 1 }),
  title
});

/** chrome.storage.local, in memory, counting what is written. */
function memory(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const area = {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items))),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) delete data[key];
    })
  } satisfies StorageArea;
  return { data, area };
}

function setup(initial: Record<string, unknown> = {}) {
  const { data, area } = memory(initial);
  const chats = new Map<string, Chat>();
  const activity: ActivityEntry[] = [];
  const saved = vi.fn();
  const store = new ChatStore({
    storage: area,
    chat: (id) => chats.get(id),
    activity: () => activity,
    saved,
    delayMs: 5
  });
  return { data, area, chats, activity, saved, store };
}

describe("ChatStore", () => {
  it("writes only the chats that changed, each as its own record", async () => {
    const { data, area, chats, store } = setup();
    chats.set("a", chat("a"));
    chats.set("b", chat("b"));
    store.chatChanged("a");
    store.chatChanged("b");
    await store.flush();
    chats.set("a", chat("a", "renamed"));
    store.chatChanged("a");
    await store.flush();
    expect(area.set).toHaveBeenLastCalledWith({ [`${CHAT_PREFIX}a`]: chats.get("a") });
    expect(Object.keys(data).sort()).toEqual(["chat:a", "chat:b"]);
    expect((data["chat:a"] as Chat).title).toBe("renamed");
  });

  it("gathers a burst of changes into one write", async () => {
    const { area, chats, store } = setup();
    chats.set("a", chat("a"));
    for (let i = 0; i < 50; i += 1) store.chatChanged("a");
    await vi.waitFor(() => expect(area.set).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(area.set).toHaveBeenCalledOnce();
  });

  it("removes a deleted chat, even one changed just before", async () => {
    const { data, chats, store } = setup({ "chat:a": chat("a") });
    chats.set("a", chat("a"));
    store.chatChanged("a");
    chats.delete("a");
    store.chatDeleted("a");
    await store.flush();
    expect(data).toEqual({});
  });

  it("saves the activity log only when something was added to it", async () => {
    const { data, area, chats, activity, store } = setup();
    chats.set("a", chat("a"));
    store.chatChanged("a");
    await store.flush();
    expect(ACTIVITY_KEY in data).toBe(false);
    activity.push({
      at: 1,
      chatId: "a",
      harness: "Scripted",
      tool: "snapshot",
      origin: "https://a.example",
      outcome: "done",
      ms: 3
    });
    store.activityAdded();
    await store.flush();
    expect(area.set).toHaveBeenLastCalledWith({ [ACTIVITY_KEY]: activity });
  });

  it("writes nothing when nothing changed", async () => {
    const { area, store } = setup();
    await store.flush();
    expect(area.set).not.toHaveBeenCalled();
    expect(area.remove).not.toHaveBeenCalled();
  });

  it("reports a failed save and carries its changes into the next one", async () => {
    const { data, area, chats, saved, store } = setup();
    chats.set("a", chat("a"));
    store.chatChanged("a");
    area.set.mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));
    await store.flush();
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ message: "QUOTA_BYTES quota exceeded" }));
    expect(data).toEqual({});
    await store.flush();
    expect(saved).toHaveBeenLastCalledWith(null);
    expect(Object.keys(data)).toEqual(["chat:a"]);
  });

  it("loads chats and hands back the other records untouched", async () => {
    const settings = { cwd: "/tmp/p", pageToolsOnly: true };
    const { store } = setup({ "chat:a": chat("a"), "chat:b": chat("b"), settings, alwaysAllowed: ["k"] });
    const loaded = await store.load();
    expect(loaded.chats.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(loaded.rest).toEqual({ settings, alwaysAllowed: ["k"] });
  });

  it("splits the old single list into one record per chat, once", async () => {
    const { data, store } = setup({
      chats: [chat("old-1"), chat("old-2", "stale")],
      "chat:old-2": chat("old-2", "newer"),
      settings: { cwd: "" }
    });
    const loaded = await store.load();
    expect(loaded.chats.map((entry) => entry.id).sort()).toEqual(["old-1", "old-2"]);
    expect(loaded.chats.find((entry) => entry.id === "old-2")?.title).toBe("newer");
    expect(Object.keys(data).sort()).toEqual(["chat:old-1", "chat:old-2", "settings"]);
    expect((await store.load()).chats).toHaveLength(2);
  });
});
