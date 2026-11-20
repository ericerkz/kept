type SortableI = { done?: boolean; indentLevel?: number; listId?: string };

type SortOptions<T> = {
  /** Text compared for each row, e.g. its plain text content. */
  text: (item: T) => string;
  /** Sort unchecked siblings before checked siblings, preserving their subtrees. */
  separateCompleted?: boolean;
  locale?: string;
};

type Branch<T> = { item: T; key: string; children: Branch<T>[] };

// Self-contained so `node --test` can run it; matches checkbox-indent.ts's bounds.
const indentOf = (item: SortableI) => {
  const level = Math.floor(Number(item?.indentLevel));
  return Number.isFinite(level) && level > 0 ? Math.min(level, 3) : 0;
};

/** Group rows into branches so nested rows stay with their parent. */
function toBranches<T extends SortableI>(items: T[], text: (item: T) => string): Branch<T>[] {
  const roots: Branch<T>[] = [];
  const stack: { level: number; branch: Branch<T> }[] = [];
  for (const item of items) {
    const level = indentOf(item);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const branch: Branch<T> = { item, key: (text(item) || '').trim(), children: [] };
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
 * Returns each checklist's rows sorted A→Z. Top-level rows are sorted together and
 * nested rows only among their siblings. Empty rows keep their relative order
 * at the end of their group. The input array is not modified.
 */
export function sortChecklistItems<T extends SortableI>(items: T[], options: SortOptions<T>): T[] {
  const collator = new Intl.Collator(options.locale, { sensitivity: 'base', numeric: true });
  const sortBranches = (branches: Branch<T>[]): Branch<T>[] => branches
    .map(branch => ({ ...branch, children: sortBranches(branch.children) }))
    .sort((a, b) => {
      if (options.separateCompleted && !!a.item.done !== !!b.item.done) return Number(!!a.item.done) - Number(!!b.item.done);
      const left = a.key, right = b.key;
      if (!left || !right) return Number(!left) - Number(!right);
      return collator.compare(left, right);
    });
  // Build the tree before considering completion state: splitting completed
  // rows first can detach children and attach them to a different parent.
  // The existing renderer displays completed rows at the bottom separately.
  const lists = new Map<string, T[]>();
  for (const item of items) {
    const id = item.listId || 'default';
    const group = lists.get(id) || [];
    group.push(item); lists.set(id, group);
  }
  return [...lists.values()].flatMap(group => flatten(sortBranches(toBranches(group, options.text))));
}
