/**
 * Checklist rows can be nested up to MAX_INDENT_LEVEL levels deep. A row may
 * never be more than one level deeper than the row above it.
 * Keep in sync with MAX_CHECKBOX_INDENT_LEVEL in server/server.js.
 */
export const MAX_INDENT_LEVEL = 3;

type IndentableI = { indentLevel?: number; listId?: string; done?: boolean };
const sameList = (a?: IndentableI, b?: IndentableI) => (a?.listId || 'default') === (b?.listId || 'default');

/**
 * `separateDone`: the editor shows checked rows in their own Completed
 * section (the "move checked items to the bottom" preference). Nesting then
 * follows what is shown: a row's parent and children are the rows around it
 * in the same section, and rows of the other section are skipped. Without it
 * a child shown under "Milk" could belong to a hidden checked row stored
 * between them, so checking "Milk" would not check it.
 */
export type IndentOptions = { separateDone?: boolean };
const sameSection = (a: IndentableI | undefined, b: IndentableI | undefined, options?: IndentOptions) =>
  !options?.separateDone || !!a?.done === !!b?.done;

/** The row shown above `index` in its list and section, if any. */
function rowAbove<T extends IndentableI>(items: T[], index: number, options?: IndentOptions): T | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (!sameList(items[index], items[i])) return undefined;
    if (sameSection(items[index], items[i], options)) return items[i];
  }
  return undefined;
}

export function normalizeIndentLevel(value: unknown): number {
  const level = Math.floor(Number(value));
  if (!Number.isFinite(level) || level < 1) return 0;
  return Math.min(level, MAX_INDENT_LEVEL);
}

/** Deepest level the row at `index` is allowed to reach. */
export function maxIndentLevelAt(items: IndentableI[], index: number, options?: IndentOptions): number {
  const above = index > 0 ? rowAbove(items, index, options) : undefined;
  if (!above) return 0;
  return Math.min(normalizeIndentLevel(above.indentLevel) + 1, MAX_INDENT_LEVEL);
}

/**
 * Clamp every row so no item is orphaned deeper than the row above allows.
 * With `separateDone` a row may be nested under either the row stored above
 * it or the row shown above it in its section, so neither layout loses
 * nesting (a checked child keeps its level under its open parent). Each
 * section is clamped again for display.
 */
export function normalizeIndentLevels<T extends IndentableI>(items: T[], options?: IndentOptions): T[] {
  const normalized: T[] = [];
  for (const item of items) {
    const currentLevel = normalizeIndentLevel(item?.indentLevel);
    normalized.push(item);
    const index = normalized.length - 1;
    const maxLevel = Math.max(maxIndentLevelAt(normalized, index), options?.separateDone ? maxIndentLevelAt(normalized, index, options) : 0);
    const nextLevel = Math.min(currentLevel, maxLevel);
    if (currentLevel !== nextLevel) normalized[normalized.length - 1] = { ...item, indentLevel: nextLevel };
  }
  return normalized;
}

/** Indexes of the rows nested below the row at `index` (contiguous within its section). */
export function descendantIndexes(items: IndentableI[], index: number, options?: IndentOptions): number[] {
  if (index < 0) return [];
  const level = normalizeIndentLevel(items[index]?.indentLevel);
  const indexes: number[] = [];
  for (let i = index + 1; i < items.length; i++) {
    if (!sameList(items[index], items[i])) break;
    if (!sameSection(items[index], items[i], options)) continue;
    if (normalizeIndentLevel(items[i]?.indentLevel) <= level) break;
    indexes.push(i);
  }
  return indexes;
}
