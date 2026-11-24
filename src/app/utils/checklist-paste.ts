export type ChecklistPasteItem = {
  text: string;
  done: boolean;
  indentLevel: number;
};

export type ParsedChecklistPaste = {
  items: ChecklistPasteItem[];
  isList: boolean;
};

// Self-contained so `node --test` can run it directly; matches checkbox-indent.ts.
const MAX_INDENT_LEVEL = 3;

function normalizeIndentLevel(value: unknown): number {
  const level = Math.floor(Number(value));
  if (!Number.isFinite(level) || level < 1) return 0;
  return Math.min(level, MAX_INDENT_LEVEL);
}

function normalizeIndentLevels<T extends { indentLevel: number }>(items: T[]): T[] {
  const normalized: T[] = [];
  for (const item of items) {
    const currentLevel = normalizeIndentLevel(item.indentLevel);
    const maxLevel = normalized.length
      ? Math.min(normalizeIndentLevel(normalized[normalized.length - 1].indentLevel) + 1, MAX_INDENT_LEVEL)
      : 0;
    const nextLevel = Math.min(currentLevel, maxLevel);
    normalized.push(item.indentLevel === nextLevel ? item : { ...item, indentLevel: nextLevel });
  }
  return normalized;
}

const BULLET_OR_NUMBER_RE = /^(?:[-*+•◦▪‣·]|(?:\d+|[a-zA-Z])[.)])(?:\s+|$)/u;
const CHECKBOX_RE = /^(\[\s*\]|\[\s*[xX]\s*\]|[☐☑☒✓✔✅])(?:\s+|$)/u;
const DONE_CHECKBOX_RE = /^(?:\[\s*[xX]\s*\]|[☑☒✓✔✅])$/u;

function leadingIndent(line: string): { indentLevel: number; rest: string } {
  const match = line.match(/^[ \t]*/);
  const prefix = match ? match[0] : '';
  let tabs = 0;
  let spaces = 0;
  for (const ch of prefix) {
    if (ch === '\t') tabs++;
    else if (ch === ' ') spaces++;
  }
  return {
    indentLevel: tabs + Math.floor(spaces / 2),
    rest: line.slice(prefix.length).trimStart()
  };
}

/**
 * Parse plain clipboard text into checklist items, stripping bullets,
 * numbered/lettered markers, and checkbox markers while preserving nesting.
 */
export function parseChecklistLines(text: string): ParsedChecklistPaste {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const rawItems: ChecklistPasteItem[] = [];
  let nonEmptyLines = 0;
  let markedLines = 0;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    nonEmptyLines++;

    const { indentLevel, rest: afterIndent } = leadingIndent(rawLine);
    let rest = afterIndent;
    let hasMarker = false;
    let done = false;

    const bulletMatch = rest.match(BULLET_OR_NUMBER_RE);
    if (bulletMatch) {
      hasMarker = true;
      rest = rest.slice(bulletMatch[0].length);
    }

    const checkboxMatch = rest.match(CHECKBOX_RE);
    if (checkboxMatch) {
      hasMarker = true;
      done = DONE_CHECKBOX_RE.test(checkboxMatch[1]);
      rest = rest.slice(checkboxMatch[0].length);
    }

    if (hasMarker) markedLines++;

    const itemText = rest.trim();
    if (!itemText) continue;

    rawItems.push({ text: itemText, done, indentLevel });
  }

  if (!rawItems.length) {
    return { items: [], isList: false };
  }

  const minIndent = Math.min(...rawItems.map(item => item.indentLevel));
  const relative = minIndent > 0
    ? rawItems.map(item => ({ ...item, indentLevel: item.indentLevel - minIndent }))
    : rawItems;
  const items = normalizeIndentLevels(relative);
  const isList = items.length >= 2 && nonEmptyLines > 0 && markedLines * 3 >= nonEmptyLines * 2;

  return { items, isList };
}

/** HTML-escape plain text for storage in CheckboxI.data. */
export function checklistItemHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
