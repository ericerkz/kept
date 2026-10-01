/**
 * Checklist rows can be nested up to MAX_INDENT_LEVEL levels deep. A row may
 * never be more than one level deeper than the row above it.
 * Keep in sync with MAX_CHECKBOX_INDENT_LEVEL in server/server.js.
 */
export const MAX_INDENT_LEVEL = 3;

type IndentableI = { indentLevel?: number };

export function normalizeIndentLevel(value: unknown): number {
  const level = Math.floor(Number(value));
  if (!Number.isFinite(level) || level < 1) return 0;
  return Math.min(level, MAX_INDENT_LEVEL);
}

/** Deepest level the row at `index` is allowed to reach. */
export function maxIndentLevelAt(items: IndentableI[], index: number): number {
  if (index <= 0) return 0;
  return Math.min(normalizeIndentLevel(items[index - 1]?.indentLevel) + 1, MAX_INDENT_LEVEL);
}

/** Clamp every row so no item is orphaned deeper than the row above allows. */
export function normalizeIndentLevels<T extends IndentableI>(items: T[]): T[] {
  const normalized: T[] = [];
  for (const item of items) {
    const currentLevel = normalizeIndentLevel(item?.indentLevel);
    const maxLevel = normalized.length
      ? Math.min(normalizeIndentLevel(normalized[normalized.length - 1]?.indentLevel) + 1, MAX_INDENT_LEVEL)
      : 0;
    const nextLevel = Math.min(currentLevel, maxLevel);
    normalized.push(currentLevel === nextLevel ? item : { ...item, indentLevel: nextLevel });
  }
  return normalized;
}

/** Indexes of the contiguous rows nested below the row at `index`. */
export function descendantIndexes(items: IndentableI[], index: number): number[] {
  if (index < 0) return [];
  const level = normalizeIndentLevel(items[index]?.indentLevel);
  const indexes: number[] = [];
  for (let i = index + 1; i < items.length; i++) {
    if (normalizeIndentLevel(items[i]?.indentLevel) <= level) break;
    indexes.push(i);
  }
  return indexes;
}
