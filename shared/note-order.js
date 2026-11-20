// Reordering changes personal positions, never the note content clock.
// A normal drag needs one new rank between its neighbours. Bulk permutations
// and exhausted/equal ranks retain the existing full rebalance fallback.
function notePositionsForOrder(rows, base = Date.now(), movedSyncId) {
  const rebalance = () => rows.map((row, index) => ({id:row.id, syncId:row.syncId, sortOrder:base + rows.length - index}));
  const moved = movedSyncId && rows.find(row => row.syncId === movedSyncId);
  if (moved && !rows.some((row,index) => index && !rows[index-1].pinned && row.pinned)) {
    const group = rows.filter(row => !!row.pinned === !!moved.pinned);
    const index = group.indexOf(moved);
    const position = positionBetweenNotes(moved,group[index-1],group[index+1],base);
    return position ? [position] : rebalance();
  }
  const current = [...rows].sort((a,b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.sortOrder || 0) - Number(a.sortOrder || 0) || Number(b.id || 0) - Number(a.id || 0));
  const first = rows.findIndex((row,index) => row.syncId !== current[index].syncId);
  if (first < 0) return [];
  for (const candidate of [rows[first], current[first]]) {
    const rest = current.filter(row => row.syncId !== candidate.syncId);
    if (!rows.filter(row => row.syncId !== candidate.syncId).every((row,index) => row.syncId === rest[index].syncId)) continue;
    // A pin/unpin is a separate operation. Never move a rank across pin groups.
    if (rows.some((row,index) => index && !rows[index-1].pinned && row.pinned)) return rebalance();
    const group = rows.filter(row => !!row.pinned === !!candidate.pinned);
    const index = group.findIndex(row => row.syncId === candidate.syncId);
    const position = positionBetweenNotes(candidate,group[index-1],group[index+1],base);
    return position ? [position] : rebalance();
  }
  return rebalance();
}
function positionBetweenNotes(note, previous, next, base = Date.now()) {
  const above = previous ? Number(previous.sortOrder) : undefined;
  const below = next ? Number(next.sortOrder) : undefined;
  const rank = above === undefined ? (below === undefined ? base : below + 1)
    : below === undefined ? above - 1 : below + (above - below) / 2;
  if (!Number.isFinite(rank) || rank === 0 || (above !== undefined && (!Number.isFinite(above) || rank >= above)) ||
    (below !== undefined && (!Number.isFinite(below) || rank <= below))) return null;
  return {id:note.id,syncId:note.syncId,sortOrder:rank};
}
module.exports = { notePositionsForOrder, positionBetweenNotes };
