const sourceFields = require('../shared/takeout-source-fields.json');
const sourceFieldSet = new Set(sourceFields);

// These source fields already have canonical Kept counterparts. Leave unknown
// metadata (including annotations) intact rather than imposing a new whitelist.
function withoutTakeoutSourceFields(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !sourceFieldSet.has(key)));
}

async function cleanImportedMetadata({ get, run, withDatabaseTransaction }) {
  if ((await get("SELECT value FROM app_settings WHERE key = 'takeoutSourceFieldsRemoved'"))?.value === '1') return;
  await withDatabaseTransaction(async () => {
    const targets = [
      { table: 'notes', column: 'extraFields', roots: ['$'], where: '1' },
      { table: 'sync_changes', column: 'payload', roots: ['$'], where: "resourceType = 'note'" },
      { table: 'workspace_operations', column: 'result', roots: ['$.canonical', '$.payload'], where: "json_extract(result, '$.resourceType') IN ('note','note-view-state')" }
    ];
    for (const { table, column, roots, where } of targets) {
      const paths = roots.flatMap(root => sourceFields.map(field => `${root}.${field}`));
      // Preserve sequences, clocks and operation fingerprints: existing clients
      // can continue from their cursors and replay already-received operations.
      await run(`UPDATE ${table} SET ${column} = json_remove(${column}, ${paths.map(() => '?').join(',')})
        WHERE json_valid(${column}) AND (${where}) AND (${paths.map(() => `json_type(${column}, ?) IS NOT NULL`).join(' OR ')})`, [...paths, ...paths]);
    }
    await run("INSERT OR REPLACE INTO app_settings(key,value) VALUES('takeoutSourceFieldsRemoved','1')");
  });
}

module.exports = { withoutTakeoutSourceFields, cleanImportedMetadata };
