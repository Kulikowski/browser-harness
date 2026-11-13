/**
 * The text view of a page that the harness reads, made from Chrome's accessibility tree
 * (CDP Accessibility.getFullAXTree).
 *
 * It works in two steps. `collect` flattens the tree into a list of pieces: loose text, headings,
 * controls and line breaks. `write` turns the pieces into lines: text runs joined on one line,
 * headings with "#" marks for their level, and every control as `[ref] role "label"` with its value
 * and state, where ref is the node's backendDOMNodeId.
 */

/** The parts of a CDP AXNode this file reads. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}
interface AXValue {
  value?: unknown;
}

type Piece =
  | { kind: "text"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "control"; ref: number; role: string; label: string; value: string; states: string[] }
  | { kind: "break" };

/** Roles a person operates: the WAI-ARIA widget roles, then Chrome's own names for native controls. */
const WIDGET_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
  "ColorWell",
  "Date",
  "DateTime",
  "DisclosureTriangle",
  "InputTime",
  "PopUpButton",
  "ToggleButton"
]);

/** Roles that start and end a line of text, the way block elements do on screen. */
const LINE_ROLES = new Set([
  "blockquote",
  "cell",
  "columnheader",
  "definition",
  "gridcell",
  "LabelText",
  "listitem",
  "paragraph",
  "row",
  "rowheader",
  "term"
]);

/** Focusable, but the page itself rather than something in it. */
const DOCUMENT_ROLES = new Set(["RootWebArea", "WebArea", "Iframe"]);

/** How each state reads in a control's line, in the order they are written. */
const STATE_WORDS: [property: string, word: (value: unknown) => string][] = [
  ["checked", (value) => (value === "mixed" ? "partly checked" : isOn(value) ? "checked" : "unchecked")],
  ["pressed", (value) => (isOn(value) ? "pressed" : "")],
  ["expanded", (value) => (isOn(value) ? "expanded" : "collapsed")],
  ["selected", (value) => (isOn(value) ? "selected" : "")],
  ["disabled", (value) => (isOn(value) ? "disabled" : "")],
  ["required", (value) => (isOn(value) ? "required" : "")],
  ["focused", (value) => (isOn(value) ? "focused" : "")]
];

const LABEL_LENGTH = 80;
const SNAPSHOT_LIMIT = 40_000;

export function formatSnapshot(nodes: AXNode[], page: { title: string; url: string }): string {
  const lines = [`Page: ${page.title || "(untitled)"} (${page.url})`, ...write(collect(nodes))];
  const out = lines.join("\n");
  if (out.length <= SNAPSHOT_LIMIT) return out;
  return `${out.slice(0, SNAPSHOT_LIMIT)}\n… snapshot cut at ${SNAPSHOT_LIMIT} characters; scroll and snapshot again for more.`;
}

/** Step one: the tree, top to bottom, as a flat list of pieces. */
function collect(nodes: AXNode[]): Piece[] {
  const index = new Map<string, AXNode>();
  for (const node of nodes) index.set(node.nodeId, node);
  const pieces: Piece[] = [];

  // `said` holds what the enclosing headings and controls already say, in lower case, so the same
  // words are not printed a second time as loose text underneath them.
  const visit = (node: AXNode | undefined, said: readonly string[]): void => {
    if (!node) return;
    const below = (alsoSaid: readonly string[] = said) => {
      for (const id of node.childIds ?? []) visit(index.get(id), alsoSaid);
    };
    if (node.ignored) return below();

    const role = roleOf(node);
    const label = tidy(axValue(node.name));

    if (role === "StaticText") {
      const words = label.toLowerCase();
      if (label && !said.some((earlier) => earlier.includes(words))) pieces.push({ kind: "text", text: label });
      return; // its children are the same text again, cut into line boxes
    }
    if (role === "LineBreak") {
      pieces.push({ kind: "break" });
      return;
    }
    if (role === "heading" && label) {
      pieces.push({ kind: "heading", level: headingLevel(node), text: label });
      return below([...said, label.toLowerCase()]);
    }
    if (isControl(node, role, label)) {
      const value = tidy(axValue(node.value));
      pieces.push({ kind: "control", ref: node.backendDOMNodeId!, role, label, value, states: statesOf(node) });
      return below([...said, label.toLowerCase(), value.toLowerCase()].filter(Boolean));
    }
    const ownLine = LINE_ROLES.has(role);
    if (ownLine) pieces.push({ kind: "break" });
    below();
    if (ownLine) pieces.push({ kind: "break" });
  };

  visit(nodes.find((node) => !node.parentId) ?? nodes[0], []);
  return pieces;
}

/** Step two: the pieces as lines. */
function write(pieces: Piece[]): string[] {
  const lines: string[] = [];
  let run: string[] = [];
  /** Index of the line most recently written from loose text. */
  let textLine = -1;
  const endRun = () => {
    if (run.length === 0) return;
    textLine = lines.push(run.join(" ")) - 1;
    run = [];
  };

  for (const piece of pieces) {
    if (piece.kind === "text") {
      run.push(piece.text);
      continue;
    }
    endRun();
    if (piece.kind === "break") continue;
    if (piece.kind === "heading") {
      lines.push(`${"#".repeat(piece.level)} ${piece.text}`);
      continue;
    }
    // A visible label right above its control would say the same thing twice: keep the control.
    if (textLine >= 0 && textLine === lines.length - 1 && lines[textLine]!.toLowerCase() === piece.label.toLowerCase())
      lines.pop();
    let line = `[${piece.ref}] ${piece.role} "${shorten(piece.label, LABEL_LENGTH)}"`;
    if (piece.value && piece.value !== piece.label) line += ` = "${shorten(piece.value, LABEL_LENGTH)}"`;
    if (piece.states.length > 0) line += ` ${piece.states.join(" ")}`;
    lines.push(line);
  }
  endRun();
  return lines;
}

/** A widget, or anything else the keyboard can reach that has something to call it by. */
function isControl(node: AXNode, role: string, label: string): boolean {
  if (!node.backendDOMNodeId) return false;
  if (WIDGET_ROLES.has(role)) return true;
  if (DOCUMENT_ROLES.has(role) || !isOn(property(node, "focusable"))) return false;
  return Boolean(label || tidy(axValue(node.value)) || property(node, "editable"));
}

function statesOf(node: AXNode): string[] {
  const words: string[] = [];
  for (const [name, word] of STATE_WORDS) {
    const value = property(node, name);
    if (value === undefined || value === null) continue;
    const text = word(value);
    if (text) words.push(text);
  }
  return words;
}

/** Chrome reports h1 to h6 as level 1 to 6; a heading without a level is written as "##". */
function headingLevel(node: AXNode): number {
  const level = Number(property(node, "level"));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
}

const roleOf = (node: AXNode): string => {
  const role = axValue(node.role);
  return typeof role === "string" ? role : "";
};

function property(node: AXNode, name: string): unknown {
  for (const entry of node.properties ?? []) if (entry.name === name) return axValue(entry.value);
  return undefined;
}

/** Tristate and boolean properties arrive as true or as the string "true". */
const isOn = (value: unknown): boolean => value === true || value === "true";

/** What an AXValue holds, or undefined when there is none. */
export function axValue(holder: AXValue | undefined): unknown {
  return holder?.value;
}

/** Any value as one line of text: zero-width characters dropped, whitespace runs made one space. */
export function tidy(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/[\u200B\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, with "…" as the last one when something was cut. */
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
