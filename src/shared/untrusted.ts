/**
 * Everything a page returns is written by the site, not the user. We fence it so the harness's
 * model can tell data from instructions, and so a page cannot close the fence itself.
 */
export function fencePageContent(origin: string, text: string, note?: string): string {
  const safe = text.replace(/<\/?page-content/gi, (match) => match.replace("<", "&lt;"));
  const header = `<page-content origin="${origin.replace(/"/g, "")}" trust="untrusted"${note ? ` note="${note.replace(/"/g, "'")}"` : ""}>`;
  return `${header}\n${safe}\n</page-content>`;
}
