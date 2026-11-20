import languages from '../../../shared/code-languages.json';
import { obviousCodeSyntax } from './code-detection';
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from './code-limits';
export { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from './code-limits';

export const codeLanguages = languages;
export const CODE_SELECTOR = 'pre.kept-code';
export const CODE_PREVIEW_LINES = 10;
export const codeLanguage = (value: string | null | undefined) => value === 'auto' || languages.some(item => item.id === value) ? value! : 'plaintext';
export const escapeCode = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Contenteditable may use BR or block elements for line breaks. Never trim a snippet. */
export function codeText(root: Node): string {
  let text = '';
  const block = (node: Node | null) => !!node && /^(DIV|P)$/.test(node.nodeName);
  for (const node of Array.from(root.childNodes)) {
    if (block(node)) {
      if (node.previousSibling) text += '\n';
      // A sole BR is the browser's empty-line caret, not an additional line.
      if (!(node.childNodes.length === 1 && node.firstChild?.nodeName === 'BR')) text += codeText(node);
    } else if (node.nodeName === 'BR') {
      if (root.nodeName !== 'CODE' || node !== root.lastChild) text += '\n';
    } else {
      if (block(node.previousSibling)) text += '\n';
      text += node.nodeType === 3 ? node.textContent || '' : codeText(node);
    }
  }
  return text;
}

// Angular deliberately drops data-* attributes from innerHTML in overview cards.
// Mirror these bounded tokens in classes so previews need no sanitizer bypass.
export function readCodeLanguage(pre: HTMLElement) {
  return codeLanguage(pre.getAttribute('data-code-language') || Array.from(pre.classList).find(name => name.startsWith('kept-code-lang-'))?.slice('kept-code-lang-'.length) || 'auto');
}
export function readCodeSource(pre: HTMLElement): 'auto' | 'user' {
  return pre.getAttribute('data-code-source') === 'user' || pre.classList.contains('kept-code-user') ? 'user' : 'auto';
}

export function codeBlockHtml(text = '', language = 'auto', source: 'auto' | 'user' = 'auto'): string {
  language = codeLanguage(language);
  return `<pre class="kept-code kept-code-lang-${language}${source === 'user' ? ' kept-code-user' : ''}" data-code-language="${language}" data-code-source="${source}"><code>${escapeCode(text)}</code></pre>`;
}

/** Only inspect bounded, deliberate-looking pastes; ordinary notes never load a grammar. */
export function pastedCodeCandidate(value: string): { text: string; language: string; explicit: boolean; definite?: boolean } | null {
  if (!value || value.length > MAX_HIGHLIGHT_CHARS) return null;
  const text = value.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines.length > MAX_HIGHLIGHT_LINES) return null;
  const fence = lines[0].match(/^(`{3,}|~{3,})([\w#+.-]*)[ \t]*$/);
  const end = lines.at(-1) === '' ? lines.length - 2 : lines.length - 1;
  if (fence && end > 0 && lines[end].trim() === fence[1]) {
    const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', ps: 'powershell', ps1: 'powershell', sh: 'bash', shell: 'bash', html: 'xml', yml: 'yaml', 'c#': 'csharp', 'c++': 'cpp' };
    const name = fence[2].toLowerCase();
    return { text: lines.slice(1, end).join('\n'), language: name ? codeLanguage(aliases[name] || name) : 'auto', explicit: true };
  }
  // At least two syntax-bearing lines, followed by the worker's conservative
  // language confidence check. Lists and everyday prose are left alone.
  const syntax = /^\s*(?:(?:const|let|var|def|class|function|import|from|return|public|private|using|package|SELECT|FROM|WHERE|CREATE|INSERT|UPDATE|DELETE)\b|[$][\w]+\s*=|[\w$.]+\s*\(|[\w]+-[\w]+\b|["'][\w -]+["']\s*:|<\/?[a-zA-Z][^>]*>|[{}]\s*[;,]?\s*$)/;
  let matches = 0;
  for (const line of lines) if (syntax.test(line) && ++matches >= 2) return { text, language: 'auto', explicit: false, definite: obviousCodeSyntax(text) };
  return null;
}

/** Save only semantic content: no buttons, selected language labels, colours or clipped text. */
export function cleanCodeBlocks(root: HTMLElement) {
  // The empty hit area above a leading block is editor chrome. Once typed in,
  // retain its real content as an ordinary paragraph.
  for (const line of root.querySelectorAll<HTMLElement>('.kept-code-leading-line')) {
    if (!line.textContent && !line.querySelector('img, pre, hr')) line.remove();
    else line.removeAttribute('class');
  }
  for (const pre of root.querySelectorAll<HTMLElement>(CODE_SELECTOR)) {
    const code = pre.querySelector('code');
    const text = code ? codeText(code) : codeText(pre);
    pre.outerHTML = codeBlockHtml(text, readCodeLanguage(pre), readCodeSource(pre));
  }
}

/** One budget for the entire card, even when checklists split the body into segments. */
export function codePreview(root: HTMLElement, budget = CODE_PREVIEW_LINES, read: (pre: HTMLElement) => string = pre => codeText(pre.querySelector('code') || pre)) {
  const previews: { pre: HTMLElement; text: string; visible: string; hidden: number }[] = [];
  for (const pre of root.querySelectorAll<HTMLElement>(CODE_SELECTOR)) {
    const text = read(pre);
    const lines = text.split('\n');
    const shown = Math.min(budget, lines.length);
    budget -= shown;
    previews.push({ pre, text, visible: lines.slice(0, shown).join('\n'), hidden: lines.length - shown });
  }
  return previews;
}

/** Fences longer than any run in the snippet preserve literal backticks in Markdown exports. */
export function codeBlocksToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  let marker = 'KEPT_CODE_EXPORT_';
  while (root.innerHTML.includes(marker)) marker += '_';
  for (const pre of root.querySelectorAll<HTMLElement>(CODE_SELECTOR)) {
    const text = codeText(pre.querySelector('code') || pre);
    let length = 3;
    for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    const language = readCodeLanguage(pre);
    const placeholder = root.ownerDocument.createTextNode(`${marker}${blocks.length}_END`);
    blocks.push(`\n${fence}${['auto', 'plaintext'].includes(language) ? '' : language}\n${text}\n${fence}\n`);
    pre.replaceWith(placeholder);
  }
  return root.innerHTML.replace(new RegExp(`${marker}(\\d+)_END`, 'g'), (_, index) => blocks[Number(index)]);
}

/** Indent selected lines without replacing the selection's source code. */
export function indentCode(text: string, start: number, end: number, outdent = false) {
  if (start === end && !outdent) return { text: text.slice(0, start) + '  ' + text.slice(end), start: start + 2, end: end + 2 };
  const first = start > 0 ? text.lastIndexOf('\n', start - 1) + 1 : 0;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  let stop = text.indexOf('\n', last);
  if (stop < 0) stop = text.length;
  let offset = first, shiftStart = 0, shiftEnd = 0;
  const lines = text.slice(first, stop).split('\n').map(line => {
    const removed = outdent ? (line.startsWith('\t') ? 1 : Math.min(2, line.match(/^ */)![0].length)) : 0;
    const delta = outdent ? -removed : 2;
    if (offset <= start) shiftStart += outdent ? -Math.min(removed, start - offset) : delta;
    shiftEnd += delta;
    offset += line.length + 1;
    return outdent ? line.slice(removed) : '  ' + line;
  });
  return { text: text.slice(0, first) + lines.join('\n') + text.slice(stop), start: Math.max(first, start + shiftStart), end: Math.max(first, end + shiftEnd) };
}
