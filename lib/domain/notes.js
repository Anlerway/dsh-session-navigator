/**
 * 更新说明 — a release-note document, turned into blocks the settings window can
 * draw.
 *
 * The notes are a *document*, not strings in this bundle: the maintainer edits
 * 更新说明.md, the host reads it per open, and the page draws whatever it finds.
 * That is the whole point — rewording a release note must not need a code change,
 * and a panel that survived an update must not keep showing words that were
 * replaced after it was built.
 *
 * The subset accepted here is deliberately small (headings, bullets, numbered
 * lists, rules, bold, code). Anything else stays a paragraph, so an unfamiliar
 * line still shows up as text instead of vanishing from the dialog.
 */

/** Past this the file is not a release note. Refuse rather than ship a megabyte
 *  of prose to a settings window. */
export const NOTES_MAX_BYTES = 200_000;

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(?:={3,}|-{3,}|\*{3,})$/;
const BULLET = /^[*+-]\s+(.*)$/;
const NUMBERED = /^\d{1,3}[.)]\s*(.*)$/;
const INLINE = /(\*\*|\x60)(.+?)\1/g;

/**
 * Split one line into runs of plain / bold / code text.
 *
 * @param {string} text
 * @returns {{ text: string, bold?: true, code?: true }[]}
 */
export function notesRuns(text) {
  const runs = [];
  let last = 0;
  for (const match of String(text).matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: String(text).slice(last, at) });
    runs.push(match[1] === "**" ? { text: match[2], bold: true } : { text: match[2], code: true });
    last = at + match[0].length;
  }
  if (last < String(text).length) runs.push({ text: String(text).slice(last) });
  return runs.length ? runs : [{ text: String(text) }];
}

/**
 * Parse a release-note document.
 *
 * The first line is taken as the title when it introduces the document
 * (`更新说明：…` / `Release notes`) — the dialog prints the version it is running
 * in its own header, so repeating it as body text would read as a mistake.
 *
 * @param {string} markdown
 * @returns {{ title: string, blocks: any[] }}
 */
export function parseNotes(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  /** @type {any[]} */
  const blocks = [];
  let title = "";
  // A paragraph runs until a blank line or another block starts, the way
  // markdown joins wrapped lines.
  let paragraph = "";

  const flush = () => {
    if (!paragraph) return;
    blocks.push({ kind: "p", runs: notesRuns(paragraph) });
    paragraph = "";
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    // The document's own title, once, at the very top.
    if (!blocks.length && !title && !paragraph && !HEADING.test(line) && /^(?:更新说明|Release notes)/i.test(line)) {
      title = line;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", level: heading[1].length, runs: notesRuns(heading[2].trim()) });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "list" && last.ordered === false) last.items.push(notesRuns(bullet[1].trim()));
      else blocks.push({ kind: "list", ordered: false, items: [notesRuns(bullet[1].trim())] });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "list" && last.ordered === true) last.items.push(notesRuns(numbered[1].trim()));
      else blocks.push({ kind: "list", ordered: true, items: [notesRuns(numbered[1].trim())] });
      continue;
    }
    paragraph = paragraph ? paragraph + " " + line : line;
  }
  flush();
  return { title, blocks };
}
