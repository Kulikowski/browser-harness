import { describe, expect, it } from "vitest";
import { formatSnapshot, type AXNode } from "../../src/shared/snapshot.js";

let next = 0;
function node(role: string, name: string, children: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode[] {
  const id = String((next += 1));
  const kids = children.filter((child) => !child.parentId);
  for (const kid of kids) kid.parentId = id;
  return [
    { nodeId: id, role: { value: role }, name: { value: name }, childIds: kids.map((kid) => kid.nodeId), ...extra },
    ...children
  ];
}
const tree = (...parts: AXNode[][]) => parts.flat();

describe("formatSnapshot", () => {
  it("prints text in order, headings with ##, and controls with their backend node ref", () => {
    const nodes = node(
      "RootWebArea",
      "Shop",
      tree(
        node("heading", "Order a poster", node("StaticText", "Order a poster")),
        node("paragraph", "", node("StaticText", "Pick a size.")),
        node("textbox", "Name", [], {
          backendDOMNodeId: 12,
          value: { value: "Ada" },
          properties: [{ name: "focusable", value: { value: true } }]
        }),
        node("checkbox", "Gift wrap", [], {
          backendDOMNodeId: 13,
          properties: [{ name: "checked", value: { value: "false" } }]
        }),
        node("button", "Submit order", node("StaticText", "Submit order"), { backendDOMNodeId: 14 })
      )
    );
    const out = formatSnapshot(nodes, { title: "Shop", url: "https://shop.example/" });
    expect(out.split("\n")).toEqual([
      "Page: Shop (https://shop.example/)",
      "## Order a poster",
      "Pick a size.",
      '[12] textbox "Name" = "Ada"',
      '[13] checkbox "Gift wrap" unchecked',
      '[14] button "Submit order"'
    ]);
  });

  it("skips ignored wrappers but keeps their children", () => {
    const nodes = node(
      "RootWebArea",
      "",
      node("generic", "", node("link", "Home", [], { backendDOMNodeId: 5 }), { ignored: true })
    );
    expect(formatSnapshot(nodes, { title: "", url: "u" })).toContain('[5] link "Home"');
    expect(formatSnapshot(nodes, { title: "", url: "u" })).toContain("Page: (untitled) (u)");
  });

  it("shows expanded, disabled and focused states in words", () => {
    const nodes = node(
      "RootWebArea",
      "",
      node("button", "Menu", [], {
        backendDOMNodeId: 9,
        properties: [
          { name: "expanded", value: { value: false } },
          { name: "disabled", value: { value: true } },
          { name: "focused", value: { value: true } }
        ]
      })
    );
    expect(formatSnapshot(nodes, { title: "t", url: "u" })).toContain('[9] button "Menu" collapsed disabled focused');
  });

  it("writes headings with their level, and keeps a label once when it sits above its control", () => {
    const nodes = node(
      "RootWebArea",
      "",
      tree(
        node("heading", "Checkout", node("StaticText", "Checkout"), {
          properties: [{ name: "level", value: { value: 1 } }]
        }),
        node("LabelText", "", node("StaticText", "Email")),
        node("textbox", "Email", node("StaticText", "ada@example.com"), {
          backendDOMNodeId: 3,
          value: { value: "ada@example.com" }
        }),
        node("paragraph", "", tree(node("StaticText", "We never"), node("StaticText", "share it.")))
      )
    );
    expect(formatSnapshot(nodes, { title: "t", url: "u" }).split("\n").slice(1)).toEqual([
      "# Checkout",
      '[3] textbox "Email" = "ada@example.com"',
      "We never share it."
    ]);
  });

  it("lists a focusable element that has a name, but not the page itself", () => {
    const focusable = { properties: [{ name: "focusable", value: { value: true } }] };
    const nodes = node(
      "RootWebArea",
      "Page",
      node("generic", "Open details", [], { backendDOMNodeId: 7, ...focusable }),
      { backendDOMNodeId: 1, ...focusable }
    );
    expect(formatSnapshot(nodes, { title: "t", url: "u" }).split("\n").slice(1)).toEqual([
      '[7] generic "Open details"'
    ]);
  });

  it("cuts very long pages and says so", () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      node("link", `Link number ${i} with a long name`, [], { backendDOMNodeId: 100 + i })
    );
    const out = formatSnapshot(node("RootWebArea", "", tree(...many)), { title: "t", url: "u" });
    expect(out.length).toBeLessThan(41_000);
    expect(out).toMatch(/snapshot cut at 40000 characters/);
  });
});
