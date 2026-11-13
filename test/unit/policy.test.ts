import { describe, expect, it } from "vitest";
import { alwaysKey, judge, normaliseKey, originOf, type TargetElement } from "../../src/shared/policy.js";

const el = (over: Partial<TargetElement>): TargetElement => ({
  role: "button",
  name: "",
  tag: "button",
  type: "button",
  inForm: false,
  href: null,
  ...over
});
const page = "https://shop.example";

describe("judge", () => {
  it("lets reads through", () => {
    expect(judge({ tool: "read" })).toEqual({ ask: false });
  });

  it("asks for a consequential WebMCP tool, reading the hint the page set", () => {
    const verdict = judge({
      tool: "webmcp",
      toolName: "clear_board",
      annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false }
    });
    expect(verdict).toMatchObject({ ask: true, category: "webmcp-consequential" });
    expect(verdict.reason).toContain('"clear_board"');
  });

  it("does not ask for a WebMCP tool the page marks read-only", () => {
    expect(
      judge({
        tool: "webmcp",
        toolName: "x",
        annotations: { readOnlyHint: true, consequentialHint: true, untrustedContentHint: false }
      }).ask
    ).toBe(false);
  });

  it("asks on first use of a WebMCP tool the page did not mark at all", () => {
    expect(
      judge({
        tool: "webmcp",
        toolName: "x",
        annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false }
      })
    ).toMatchObject({ ask: true, category: "webmcp-first-use" });
  });

  it.each([
    [el({ tag: "input", type: "submit", role: "button", name: "Go" }), "submit"],
    [el({ tag: "input", type: "image", name: "Go" }), "submit"],
    [el({ tag: "button", type: "", inForm: true, name: "Save" }), "submit"],
    [el({ tag: "button", type: "submit", inForm: true, name: "Save" }), "submit"],
    [el({ name: "Place order" }), "risky-click"],
    [el({ name: "Delete track" }), "risky-click"],
    [el({ name: "Clear all" }), "risky-click"],
    [el({ name: "Reset board" }), "risky-click"],
    [el({ name: "Usuń konto" }), "risky-click"],
    [el({ name: "Kup teraz" }), "risky-click"],
    [el({ role: "link", tag: "a", name: "Docs", href: "https://other.example/docs" }), "leave-site"]
  ])("asks before a click on %o (%s)", (element, category) => {
    expect(judge({ tool: "click", element, pageOrigin: page })).toMatchObject({ ask: true, category });
  });

  it.each([
    el({ tag: "button", type: "button", inForm: true, name: "Save draft" }),
    el({ tag: "button", type: "", inForm: false, name: "Next" }),
    el({ role: "link", tag: "a", name: "Cart", href: "https://shop.example/cart" }),
    el({ role: "checkbox", tag: "input", type: "checkbox", name: "Gift wrap" })
  ])("clicks %o without asking", (element) => {
    expect(judge({ tool: "click", element, pageOrigin: page }).ask).toBe(false);
  });

  it("does not match risky words inside other words", () => {
    expect(judge({ tool: "click", element: el({ name: "Bookmarks" }), pageOrigin: page }).ask).toBe(false);
    expect(judge({ tool: "click", element: el({ name: "Postcode help" }), pageOrigin: page }).ask).toBe(false);
    expect(judge({ tool: "click", element: el({ name: "Kupony" }), pageOrigin: page }).ask).toBe(false);
    expect(judge({ tool: "click", element: el({ name: "Clearance" }), pageOrigin: page }).ask).toBe(false);
  });

  it("asks before typing into a password field, or typing then Enter", () => {
    expect(
      judge({ tool: "type", element: el({ tag: "input", type: "password", role: "textbox" }), submit: false })
    ).toMatchObject({ ask: true, category: "password" });
    expect(
      judge({
        tool: "type",
        element: el({ tag: "input", type: "search", role: "searchbox", name: "Search" }),
        submit: true
      })
    ).toMatchObject({ ask: true, category: "submit" });
    expect(
      judge({ tool: "type", element: el({ tag: "input", type: "text", role: "textbox", name: "Name" }), submit: false })
        .ask
    ).toBe(false);
  });

  it("asks before Enter and Space, which both press what is focused, not before other keys", () => {
    expect(judge({ tool: "press_key", key: "Enter" })).toMatchObject({ ask: true, category: "enter-key" });
    expect(judge({ tool: "press_key", key: " " })).toMatchObject({ ask: true, category: "enter-key" });
    expect(judge({ tool: "press_key", key: "Tab" }).ask).toBe(false);
    expect(judge({ tool: "press_key", key: "Escape" }).ask).toBe(false);
  });

  it("reads every spelling of Enter as Enter, so none of them slips past the question", () => {
    for (const named of ["Enter", "enter", "Return", "\r", "\n", "\r\n"]) {
      expect(judge({ tool: "press_key", key: normaliseKey(named) }), JSON.stringify(named)).toMatchObject({
        ask: true,
        category: "enter-key"
      });
    }
    expect(normaliseKey("Spacebar")).toBe(" ");
    expect(normaliseKey("\t")).toBe("Tab");
    expect(normaliseKey("a")).toBe("a");
    expect(() => normaliseKey("\u0003")).toThrow(/control character/);
  });

  it("asks before reaching into another site's tab", () => {
    expect(judge({ tool: "other-tab", tabOrigin: "https://mail.example" })).toMatchObject({
      ask: true,
      category: "other-tab"
    });
  });

  it("asks before navigating to another origin, not within one or back", () => {
    expect(judge({ tool: "navigate", url: "https://evil.example/", back: false, pageOrigin: page })).toMatchObject({
      ask: true,
      category: "leave-site"
    });
    expect(judge({ tool: "navigate", url: "https://shop.example/a", back: false, pageOrigin: page }).ask).toBe(false);
    expect(judge({ tool: "navigate", url: null, back: true, pageOrigin: page }).ask).toBe(false);
  });

  it("treats a different port or scheme as another site", () => {
    expect(judge({ tool: "navigate", url: "http://shop.example/", back: false, pageOrigin: page }).ask).toBe(true);
    expect(judge({ tool: "navigate", url: "https://shop.example:8443/", back: false, pageOrigin: page }).ask).toBe(
      true
    );
  });
});

describe("alwaysKey", () => {
  it("is per origin and per kind, and per tool for WebMCP", () => {
    expect(alwaysKey(page, "submit")).not.toBe(alwaysKey("https://other.example", "submit"));
    expect(alwaysKey(page, "submit")).not.toBe(alwaysKey(page, "leave-site"));
    expect(alwaysKey(page, "webmcp-consequential", "a")).not.toBe(alwaysKey(page, "webmcp-consequential", "b"));
    expect(alwaysKey(page, "webmcp-first-use", "a")).not.toBe(alwaysKey(page, "webmcp-first-use", "b"));
  });

  it("is per control and per destination, so a yes to one button is not a yes to another", () => {
    const send = judge({ tool: "click", element: el({ name: "Send message" }), pageOrigin: page });
    const remove = judge({ tool: "click", element: el({ name: "Delete account" }), pageOrigin: page });
    expect(send.category).toBe(remove.category);
    expect(alwaysKey(page, send.category!, send.scope)).not.toBe(alwaysKey(page, remove.category!, remove.scope));
    expect(judge({ tool: "click", element: el({ name: "  SEND   message " }), pageOrigin: page }).scope).toBe(
      send.scope
    );
    const a = judge({ tool: "navigate", url: "https://a.example/", back: false, pageOrigin: page });
    const b = judge({ tool: "navigate", url: "https://b.example/", back: false, pageOrigin: page });
    expect(alwaysKey(page, "leave-site", a.scope)).not.toBe(alwaysKey(page, "leave-site", b.scope));
  });
});

describe("originOf", () => {
  it("returns the origin, or the input when it is not a URL", () => {
    expect(originOf("https://a.example/x?y")).toBe("https://a.example");
    expect(originOf("not a url")).toBe("not a url");
  });
});
