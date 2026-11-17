import { createNoteHtmlContainer, sanitizeNoteHtml } from './note-html';

// Text and inert position markers use noteBody; rows retain their stable IDs in
// checkBoxes. Existing notes need no migration, and backups keep both together.
export const CHECKLIST_ANCHOR_CLASS = 'kept-checklist-anchor';
export const DEFAULT_CHECKLIST_ID = 'default';
export const CHECKLIST_ANCHOR_HTML = `<div class="${CHECKLIST_ANCHOR_CLASS}"></div>`;
export type ChecklistBodyPart = { type: 'text'; html: string } | { type: 'checklist'; id: string };

export function checklistId(row?: { listId?: string }): string {
  return typeof row?.listId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.listId) ? row.listId : DEFAULT_CHECKLIST_ID;
}

export function checklistAnchorHtml(id: string): string {
  id = checklistId({ listId: id });
  return id === DEFAULT_CHECKLIST_ID ? CHECKLIST_ANCHOR_HTML
    : `<div class="${CHECKLIST_ANCHOR_CLASS} kept-list-${id}"></div>`;
}

export function isChecklistAnchor(node: Node): node is HTMLDivElement {
  return node.nodeType === 1 && (node as Element).tagName === 'DIV'
    && (node as Element).classList.contains(CHECKLIST_ANCHOR_CLASS) && !node.hasChildNodes();
}

export function checklistAnchorId(node: Element): string {
  const name = Array.from(node.classList).find(name => name.startsWith('kept-list-'));
  return checklistId({ listId: name?.slice('kept-list-'.length) });
}

export function checklistBodyParts(html: string, rows: { listId?: string }[] = [], enabled = true): ChecklistBodyPart[] {
  const parts: ChecklistBodyPart[] = [];
  const seen = new Set<string>();
  if (!html.includes(CHECKLIST_ANCHOR_CLASS)) parts.push({ type: 'text', html });
  else {
    const root = createNoteHtmlContainer();
    root.innerHTML = sanitizeNoteHtml(html);
    const anchors = Array.from(root.querySelectorAll(`.${CHECKLIST_ANCHOR_CLASS}`)).filter(isChecklistAnchor);
    let previous: Node | undefined;
    for (const anchor of [...anchors, undefined]) {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(root);
      if (previous) range.setStartAfter(previous);
      if (anchor) range.setEndBefore(anchor);
      const container = root.ownerDocument.createElement('div');
      container.append(range.cloneContents());
      parts.push({ type: 'text', html: container.innerHTML });
      if (anchor) {
        const id = checklistAnchorId(anchor);
        if (enabled && !seen.has(id)) {
          parts.push({ type: 'checklist', id });
          seen.add(id);
        }
      }
      previous = anchor;
    }
  }
  if (enabled) {
    // Recover rows whose marker is missing rather than hiding or deleting them.
    const ids = rows.length ? Array.from(new Set(rows.map(checklistId))) : seen.size ? [] : [DEFAULT_CHECKLIST_ID];
    for (const id of ids) if (!seen.has(id)) {
      parts.push({ type: 'checklist', id }, { type: 'text', html: '' });
      seen.add(id);
    }
  }
  return parts;
}

export function serializeChecklistBody(parts: ChecklistBodyPart[]): string {
  return parts.map((part, index) => part.type === 'text' ? part.html
    // Retain the original representation of a simple legacy checklist.
    : part.id === DEFAULT_CHECKLIST_ID && parts.slice(index + 1).every(next => next.type === 'text' && !next.html)
      ? '' : checklistAnchorHtml(part.id)).join('');
}
