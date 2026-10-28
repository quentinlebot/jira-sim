// Jira text formats: plain text to Atlassian Document Format and back, for descriptions and comments. No imports.

/** Plain text to Atlassian Document Format: "## " headings, "- " bullets, paragraphs. */
export function textToAdf(text: string) {
  const content: unknown[] = [];
  let bullets: unknown[] | undefined;
  const flush = () => { if (bullets) { content.push({ type: 'bulletList', content: bullets }); bullets = undefined; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('## ')) {
      flush();
      content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: line.slice(3) }] });
    } else if (/^\s*[-*] /.test(line)) {
      (bullets ??= []).push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: line.replace(/^\s*[-*] /, '') }] }] });
    } else {
      flush();
      content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    }
  }
  flush();
  return { type: 'doc', version: 1, content };
}

/** ADF back to the same plain text shape: headings as "## ", list items as "- ". */
export function adfToText(doc: unknown): string {
  const lines: string[] = [];
  const text = (n: any): string => (n?.type === 'text' ? n.text ?? '' : (n?.content ?? []).map(text).join(''));
  for (const block of (doc as any)?.content ?? []) {
    if (block.type === 'heading') { lines.push(`## ${text(block)}`); } else if (block.type === 'bulletList' || block.type === 'orderedList') {
      for (const item of block.content ?? []) { lines.push(`- ${text(item)}`); }
    } else { lines.push(text(block)); }
  }
  return lines.join('\n');
}