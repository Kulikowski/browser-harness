/**
 * Just enough Markdown for agent replies: paragraphs, bullet lists, fenced code, inline code and
 * bold. Builds elements, never HTML strings, so nothing in a reply can inject markup.
 */
import type { ComponentChildren } from "preact";

export function Markdown({ text }: { text: string }) {
  const blocks: ComponentChildren[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i += 1;
      blocks.push(
        <pre key={blocks.length}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*] /, ""));
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^\s*[-*] /.test(lines[i]!))
      para.push(lines[i++]!);
    blocks.push(<p key={blocks.length}>{inline(para.join("\n"))}</p>);
  }
  return <>{blocks}</>;
}

function inline(text: string): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    parts.push(
      token.startsWith("`") ? (
        <code key={match.index}>{token.slice(1, -1)}</code>
      ) : (
        <strong key={match.index}>{token.slice(2, -2)}</strong>
      )
    );
    last = match.index! + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
