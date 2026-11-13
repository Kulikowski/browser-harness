/**
 * When a browser tool call needs the user's yes. The harness has its own permission prompts
 * (ACP session/request_permission); this is the extension's own gate on top, because only the
 * extension knows what a click on this page would do.
 */
import type { WebMcpAnnotations } from "./webmcp.js";

export type ApprovalCategory =
  | "webmcp-consequential"
  | "webmcp-first-use"
  | "submit"
  | "risky-click"
  | "leave-site"
  | "password"
  | "enter-key"
  | "other-tab";

export interface TargetElement {
  role: string;
  name: string;
  tag: string;
  type: string;
  inForm: boolean;
  /** Absolute href when the element is a link. */
  href: string | null;
}

export type PolicyInput =
  | { tool: "webmcp"; toolName: string; annotations: WebMcpAnnotations }
  | { tool: "click"; element: TargetElement; pageOrigin: string }
  | { tool: "type"; element: TargetElement; submit: boolean }
  | { tool: "press_key"; key: string }
  | { tool: "navigate"; url: string | null; back: boolean; pageOrigin: string }
  | { tool: "other-tab"; tabOrigin: string }
  | { tool: "read" };

export interface Verdict {
  ask: boolean;
  category?: ApprovalCategory;
  /** One sentence for the approval card, saying why we ask. */
  reason?: string;
  /**
   * What exactly a remembered yes covers, within the origin and category: the control's name, or
   * the site a link leads to. "Always" for one Send button is not a yes to Delete account.
   */
  scope?: string;
}

/**
 * Words on a control that sound like they change something for real. A word list can never be
 * complete (it knows English and Polish only), so it is not the only guard: a declined action locks
 * the site for the rest of the turn (tools.ts), and unmarked WebMCP tools ask on first use.
 */
const RISKY =
  "buy|pay|purchase|order|checkout|check out|place order|delete|remove|send|submit|confirm|publish|post|transfer|subscribe|unsubscribe|book|reserve|sign out|log out|go live" +
  "|clear|reset|erase|wipe|empty|discard|revoke|archive|agree|authorize|authorise|upload|share|invite|donate|withdraw|sign up|register|upgrade|renew|deactivate" +
  "|kup|kupuję|zapłać|zamów|zamawiam|usuń|wyślij|potwierdź|opublikuj|wyczyść|zarezerwuj|wyloguj|zarejestruj";
/** \b only knows ASCII letters, so "usuń" needs its own word edges. */
const RISKY_WORDS = new RegExp(`(?<![\\p{L}\\p{N}])(${RISKY})(?![\\p{L}\\p{N}])`, "iu");

const NO: Verdict = { ask: false };

export function judge(input: PolicyInput): Verdict {
  switch (input.tool) {
    case "read":
      return NO;
    case "webmcp":
      if (input.annotations.readOnlyHint) return NO;
      if (input.annotations.consequentialHint) {
        return {
          ask: true,
          category: "webmcp-consequential",
          reason: `The page marks "${input.toolName}" as consequential.`
        };
      }
      // The page said nothing either way. Ask the first time, so "unmarked" never means "harmless".
      return {
        ask: true,
        category: "webmcp-first-use",
        reason: `The page does not say whether "${input.toolName}" changes anything, so its first use asks.`
      };
    case "click": {
      const el = input.element;
      if (isSubmitControl(el))
        return {
          ask: true,
          category: "submit",
          scope: scopeOf(el.name),
          reason: `This click submits a form ("${el.name || el.role}").`
        };
      if (RISKY_WORDS.test(el.name))
        return {
          ask: true,
          category: "risky-click",
          scope: scopeOf(el.name),
          reason: `"${el.name}" sounds like it changes something for real.`
        };
      if (el.href && leavesOrigin(el.href, input.pageOrigin)) {
        return {
          ask: true,
          category: "leave-site",
          scope: originOf(el.href),
          reason: `This link leaves ${input.pageOrigin} for ${originOf(el.href)}.`
        };
      }
      return NO;
    }
    case "type":
      if (input.element.type === "password")
        return { ask: true, category: "password", reason: "This types into a password field." };
      if (input.submit)
        return {
          ask: true,
          category: "submit",
          scope: scopeOf(input.element.name),
          reason: `Typing then pressing Enter submits "${input.element.name || "the field"}".`
        };
      return NO;
    case "press_key":
      // Space presses a focused button just like Enter does, so both ask.
      if (input.key === "Enter")
        return { ask: true, category: "enter-key", reason: "Enter can submit whatever is focused." };
      if (input.key === " ") return { ask: true, category: "enter-key", reason: "Space presses whatever is focused." };
      return NO;
    case "navigate":
      if (input.back || input.url === null) return NO;
      if (leavesOrigin(input.url, input.pageOrigin)) {
        return {
          ask: true,
          category: "leave-site",
          scope: originOf(input.url),
          reason: `This opens ${originOf(input.url)}, away from ${input.pageOrigin || "the current page"}.`
        };
      }
      return NO;
    case "other-tab":
      // Reading is harmless on the page the user pointed at; another site's tab is one they did not.
      return {
        ask: true,
        category: "other-tab",
        reason: `This reaches into another tab (${input.tabOrigin}), not the page you were on when you sent your message.`
      };
  }
}

/** A control's name as a scope: case and spacing do not make it a different control. */
function scopeOf(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);
}

/**
 * The key the agent named, as the one that will be pressed. Enter has several spellings, and a
 * carriage return typed as a character is Enter to the page, so they all become "Enter" before the
 * policy sees them. Other control characters are not keys a person presses.
 */
export function normaliseKey(named: string): string {
  if (/^(space|spacebar)$/i.test(named)) return " ";
  if (/^(enter|return)$/i.test(named) || named === "\r" || named === "\n" || named === "\r\n") return "Enter";
  if (named === "\t") return "Tab";
  if (/^(esc|escape)$/i.test(named)) return "Escape";
  if (/[\p{Cc}]/u.test(named))
    throw new Error("That is a control character, not a key. Use a key name like Enter, Tab or Escape.");
  return named;
}

function isSubmitControl(el: TargetElement): boolean {
  const tag = el.tag.toLowerCase();
  const type = el.type.toLowerCase();
  if (tag === "input" && (type === "submit" || type === "image")) return true;
  // A <button> with no type submits its form.
  return tag === "button" && el.inForm && (type === "" || type === "submit");
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function leavesOrigin(url: string, pageOrigin: string): boolean {
  const target = originOf(url);
  return target !== pageOrigin;
}

/**
 * Key for "Always allow on this site": per origin and per kind of action, never global, and
 * narrowed by `scope` where there is one (the WebMCP tool, the control's name, the site a link
 * leads to).
 */
export function alwaysKey(origin: string, category: ApprovalCategory, scope?: string): string {
  const webmcp = category === "webmcp-consequential" || category === "webmcp-first-use";
  return webmcp || scope ? `${origin} ${category} ${scope ?? ""}` : `${origin} ${category}`;
}
