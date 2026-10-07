function resourceTypeForLocalKind(kind) {
  if (kind === 'reminder') return 'reminder';
  if (kind === 'attachment') return 'attachment';
  return 'note.content';
}

async function encodeOutboxEntry(entry, encryptJson, keyFor) {
  if (entry.mutationType === 'resource.delete') {
    const kind = entry.payload?.localResourceKind || 'note';
    return {
      ...entry,
      payload: {
        resourceType: resourceTypeForLocalKind(kind)
      }
    };
  }
  if (entry.mutationType !== 'resource.upsert') return entry;
  const kind = entry.payload?.localResourceKind || 'note';
  const resourceType = resourceTypeForLocalKind(kind);
  const key = await keyFor(entry.resourceId, resourceType);
  const envelope = await encryptJson({
    resourceId: entry.resourceId,
    resourceType,
    value: entry.payload?.value,
    key,
    lww: entry.lww
  });
  return {
    ...entry,
    payload: { envelope }
  };
}

function removableOperationIds(results) {
  return (Array.isArray(results) ? results : []).filter(result => result.ok).map(result => result.operationId);
}

module.exports = {
  encodeOutboxEntry,
  removableOperationIds,
  resourceTypeForLocalKind
};
