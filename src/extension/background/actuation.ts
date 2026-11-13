/**
 * Driving a page that has no WebMCP, over chrome.debugger (the Chrome DevTools Protocol).
 *
 * The agent reads the page as text made from the accessibility tree (shared/snapshot.ts), where
 * every control carries a ref, its backendDOMNodeId. It acts on a ref the way a person would: the
 * element is scrolled into view and clicked at the centre of its box with Input.dispatchMouseEvent,
 * and text is typed with Input.insertText. These are trusted input events, which pages treat like
 * a person's, unlike element.click() from a content script.
 */
import { messageOf } from "../../shared/errors.js";
import { originOf } from "../../shared/policy.js";
import { fencePageContent } from "../../shared/untrusted.js";
import type { TargetElement } from "../../shared/policy.js";
import { axValue, formatSnapshot, shorten, tidy, type AXNode } from "../../shared/snapshot.js";

type Params = Record<string, unknown>;

const attached = new Set<number>();

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

export async function cdp<T = Params>(tabId: number, method: string, params: Params = {}): Promise<T> {
  await attach(tabId);
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // A service worker restart forgets the set but Chrome keeps our session.
    if (!/already attached/i.test(messageOf(error))) throw error;
  }
  attached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {});
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable", {});
}

export async function detachAll(): Promise<void> {
  for (const tabId of [...attached]) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  attached.clear();
}

/**
 * Which document the tab shows now. It changes on every real navigation or reload and stays the same
 * while a single-page app re-renders, which is exactly how long a snapshot's refs stay meaningful.
 */
export async function documentId(tabId: number): Promise<string> {
  const { frameTree } = await cdp<{ frameTree: { frame: { loaderId: string } } }>(tabId, "Page.getFrameTree", {});
  return frameTree.frame.loaderId;
}

export async function snapshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const { nodes } = await cdp<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree", {});
  return formatSnapshot(nodes, { title: tab.title ?? "", url: tab.url ?? "" });
}

class GoneError extends Error {}

/** What a ref points at, for the approval policy and for messages. */
export async function describeElement(tabId: number, ref: number): Promise<TargetElement> {
  let objectId: string;
  try {
    ({
      object: { objectId }
    } = (await cdp<{ object: { objectId: string } }>(tabId, "DOM.resolveNode", { backendNodeId: ref })) as {
      object: { objectId: string };
    });
  } catch {
    throw new GoneError(`There is no element [${ref}] on the page any more. Take a new snapshot.`);
  }
  const { result } = await cdp<{ result: { value: Omit<TargetElement, "role" | "name"> & { label: string } } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
      const own = this.nodeType === 1 ? this : this.parentElement;
      // A ref on the text or icon inside a button is still a click on that button.
      const el = own.closest("button, input[type=submit], input[type=image]") || own;
      const link = el.closest("a[href]");
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        inForm: !!(el.form || el.closest("form")),
        href: link ? link.href : null,
        label: (el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").trim().slice(0, 120)
      };
    }`
    }
  );
  let role = "";
  let name = result.value.label;
  try {
    const partial = await cdp<{ nodes: AXNode[] }>(tabId, "Accessibility.getPartialAXTree", {
      backendNodeId: ref,
      fetchRelatives: false
    });
    const node = partial.nodes.find((entry) => entry.backendDOMNodeId === ref) ?? partial.nodes[0];
    role = String(axValue(node?.role) ?? "");
    name = tidy(axValue(node?.name)) || name;
  } catch {
    // The DOM description is enough.
  }
  return {
    role,
    name,
    tag: result.value.tag,
    type: result.value.type,
    inForm: result.value.inForm,
    href: result.value.href
  };
}

async function centreOf(tabId: number, ref: number): Promise<{ x: number; y: number }> {
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }).catch(() => undefined);
  const { quads } = await cdp<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId: ref });
  const quad = quads.find((q) => q.length === 8);
  if (!quad) throw new Error(`Element [${ref}] has no box on screen (hidden or zero-size).`);
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

export async function click(tabId: number, ref: number): Promise<string> {
  const { x, y } = await centreOf(tabId, ref);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await settle(tabId);
  return `Clicked [${ref}].`;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " }
};

export async function pressKey(tabId: number, key: string): Promise<string> {
  const known = KEYS[key];
  // A control character would be sent as its key code: "\r" is Enter to the page. The policy only
  // judged the key by name, so nothing reaches the page here that it did not see as that name.
  if (!known && /\p{Cc}/u.test(key))
    throw new Error(
      `"${JSON.stringify(key).slice(1, -1)}" is a control character, not a key. Use a key name like Enter or Tab.`
    );
  if (!known && key.length !== 1)
    throw new Error(`Unknown key "${key}". Use a single character or one of: ${Object.keys(KEYS).join(", ")}.`);
  const info = known ?? { code: "", keyCode: key.toUpperCase().charCodeAt(0), text: key };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: info.text ? "keyDown" : "rawKeyDown",
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    text: info.text
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode
  });
  await settle(tabId);
  return `Pressed ${key === " " ? "Space" : key}.`;
}

export async function type(tabId: number, ref: number, text: string, submit: boolean): Promise<string> {
  const { object } = await cdp<{ object: { objectId: string } }>(tabId, "DOM.resolveNode", { backendNodeId: ref });
  await cdp(tabId, "DOM.focus", { backendNodeId: ref }).catch(() => undefined);
  // Select what is there so insertText replaces it, like a person selecting all and typing.
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function () {
      this.focus();
      if (typeof this.select === "function") this.select();
      else { const range = document.createRange(); range.selectNodeContents(this); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    }`
  });
  if (text === "") await pressKey(tabId, "Backspace");
  else await cdp(tabId, "Input.insertText", { text });
  const { result } = await cdp<{ result: { value?: string } }>(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: "function () { return 'value' in this ? String(this.value) : this.textContent; }"
  });
  if (submit) await pressKey(tabId, "Enter");
  const shows = result.value ?? "";
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return `Typed into [${ref}]${submit ? ", then pressed Enter" : ""}. It now shows:\n${fencePageContent(originOf(tab?.url ?? ""), shorten(shows, 80))}`;
}

export async function scroll(
  tabId: number,
  direction: "up" | "down" | undefined,
  ref: number | undefined
): Promise<string> {
  if (ref !== undefined) {
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref });
    return `Scrolled [${ref}] into view.`;
  }
  const sign = direction === "up" ? -1 : 1;
  const { result } = await cdp<{ result: { value: string } }>(tabId, "Runtime.evaluate", {
    expression: `(() => { const before = scrollY; scrollBy({ top: ${sign} * innerHeight * 0.8, behavior: "instant" }); return Math.round(scrollY) + " of " + Math.round(document.documentElement.scrollHeight - innerHeight) + (scrollY === before ? " (did not move)" : ""); })()`,
    returnByValue: true
  });
  return `Scrolled ${direction ?? "down"}; now at ${result.value} px.`;
}

export async function screenshot(tabId: number): Promise<{ data: string; mimeType: string }> {
  const { data } = await cdp<{ data: string }>(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  return { data, mimeType: "image/jpeg" };
}

export async function navigate(tabId: number, target: { url?: string; back?: boolean }): Promise<string> {
  if (target.back) {
    await chrome.tabs.goBack(tabId);
  } else {
    const url = new URL(String(target.url));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only http and https URLs can be opened.");
    await chrome.tabs.update(tabId, { url: url.href });
  }
  await waitForLoad(tabId, 20_000);
  const tab = await chrome.tabs.get(tabId);
  // The title is the page's words, so it goes inside the fence.
  return `Now at ${tab.url}.\n${fencePageContent(originOf(tab.url ?? ""), `Title: ${tab.title ?? ""}`)}`;
}

function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Give the page a moment to react (navigation, re-render) before the agent looks again. */
async function settle(tabId: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading") await waitForLoad(tabId, 10_000);
}

export { GoneError };
