type SortableI = { done?: boolean; indentLevel?: number };

type SortOptions<T> = {
  /** Text compared for each row, e.g. its plain text content. */
  text: (item: T) => string;
  /** Sort unchecked and checked rows as separate groups (unchecked first). */
  separateCompleted?: boolean;
  locale?: string;
};

type Branch<T> = { item: T; children: Branch<T>[] };

// Self-contained so `node --test` can run it; matches normalizeIndentLevel's lower bound.
const indentOf = (item: SortableI) => {
  const level = Math.floor(Number(item?.indentLevel));
  return Number.isFinite(level) && level > 0 ? level : 0;
};

/** Group rows into branches so nested rows stay with their parent. */
function toBranches<T extends SortableI>(items: T[]): Branch<T>[] {
  const roots: Branch<T>[] = [];
  const stack: { level: number; branch: Branch<T> }[] = [];
  for (const item of items) {
    const level = indentOf(item);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const branch: Branch<T> = { item, children: [] };
    (stack.length ? stack[stack.length - 1].branch.children : roots).push(branch);
    stack.push({ level, branch });
  }
  return roots;
}

function flatten<T>(branches: Branch<T>[], out: T[] = []): T[] {
  for (const branch of branches) {
    out.push(branch.item);
    flatten(branch.children, out);
  }
  return out;
}

/**
 * Returns checklist rows sorted A→Z. Top-level rows are sorted together and
 * nested rows only among their siblings. Empty rows keep their relative order
 * at the end of their group. The input array is not modified.
 */
export function sortChecklistItems<T extends SortableI>(items: T[], options: SortOptions<T>): T[] {
  const collator = new Intl.Collator(options.locale, { sensitivity: 'base', numeric: true });
  const key = (branch: Branch<T>) => (options.text(branch.item) || '').trim();
  const sortBranches = (branches: Branch<T>[]): Branch<T>[] => branches
    .map(branch => ({ ...branch, children: sortBranches(branch.children) }))
    .sort((a, b) => {
      const left = key(a), right = key(b);
      if (!left || !right) return Number(!left) - Number(!right);
      return collator.compare(left, right);
    });
  const sortGroup = (group: T[]) => flatten(sortBranches(toBranches(group)));

  if (!options.separateCompleted) return sortGroup(items);
  return [
    ...sortGroup(items.filter(item => !item.done)),
    ...sortGroup(items.filter(item => !!item.done))
  ];
}
