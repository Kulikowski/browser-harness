/**
 * Which tab "the tab the user is looking at" means. The side panel is not a tab, but when the
 * panel is opened as a page (tests, or a detached window) its own tab must never be the target, so
 * we remember the last focused http(s) tab and fall back to it.
 */
const KEY = "lastWebTab";

export function isWebUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//.test(url);
}

export async function rememberTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isWebUrl(tab.url)) await chrome.storage.session.set({ [KEY]: tabId });
}

/**
 * The tab a tool call acts on. An explicit tabId from the agent wins. Otherwise it is the tab the
 * chat's turn started on (`pinned`), so switching tabs mid-turn never moves the agent's hands to
 * another page. Only when there is neither (or the pinned tab is gone) is it the tab in view now.
 */
export async function targetTab(explicit?: unknown, pinned?: number): Promise<chrome.tabs.Tab> {
  if (explicit !== undefined && explicit !== null) {
    const tab = await chrome.tabs.get(Number(explicit)).catch(() => null);
    if (!tab) throw new Error(`There is no tab ${String(explicit)}. Call tabs to see the open ones.`);
    return tab;
  }
  if (pinned !== undefined) {
    const tab = await chrome.tabs.get(pinned).catch(() => null);
    if (tab && isWebUrl(tab.url)) return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isWebUrl(active.url)) return active;
  const stored = (await chrome.storage.session.get(KEY))[KEY] as number | undefined;
  if (stored !== undefined) {
    const tab = await chrome.tabs.get(stored).catch(() => null);
    if (tab && isWebUrl(tab.url)) return tab;
  }
  const [anyWeb] = (await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })).sort(
    (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
  );
  if (anyWeb) return anyWeb;
  throw new Error("No web page is open. Ask the user to open one, or use navigate with a tabId from tabs.");
}
