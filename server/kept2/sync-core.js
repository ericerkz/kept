function normalizeLwwStamp(stamp) {
  return {
    physicalMs: Number(stamp?.physicalMs || 0),
    logical: Number(stamp?.logical || 0),
    deviceId: String(stamp?.deviceId || ''),
    operationId: String(stamp?.operationId || '')
  };
}

function compareLwwStamp(left, right) {
  const a = normalizeLwwStamp(left);
  const b = normalizeLwwStamp(right);
  if (a.physicalMs !== b.physicalMs) return a.physicalMs > b.physicalMs ? 1 : -1;
  if (a.logical !== b.logical) return a.logical > b.logical ? 1 : -1;
  const device = a.deviceId.localeCompare(b.deviceId);
  if (device !== 0) return device > 0 ? 1 : -1;
  const operation = a.operationId.localeCompare(b.operationId);
  if (operation !== 0) return operation > 0 ? 1 : -1;
  return 0;
}

function lwwStampFromRow(row) {
  if (!row) return null;
  return normalizeLwwStamp({
    physicalMs: row.lwwPhysicalMs,
    logical: row.lwwLogical,
    deviceId: row.lwwDeviceId,
    operationId: row.lwwOperationId
  });
}

function shouldApplyLww(existingRow, incomingStamp) {
  if (!existingRow) return true;
  return compareLwwStamp(incomingStamp, lwwStampFromRow(existingRow)) > 0;
}

module.exports = {
  compareLwwStamp,
  lwwStampFromRow,
  normalizeLwwStamp,
  shouldApplyLww
};
