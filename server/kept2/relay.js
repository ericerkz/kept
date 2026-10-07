const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const protocolVersion = 'encrypted-v1';

function mountKept2Relay(app, deps) {
  const {
    run,
    get,
    all,
    asyncRoute,
    requireAuth,
    withDatabaseTransaction,
    afterDatabaseCommit,
    broadcastRealtime,
    dataDir
  } = deps;
  const kept2BlobDir = path.join(dataDir, 'kept2-blobs');
  fs.mkdirSync(kept2BlobDir, { recursive: true });

  const upload = multer({
    dest: path.join(kept2BlobDir, 'tmp'),
    limits: { fileSize: Number(process.env.KEPT2_BLOB_UPLOAD_MAX || 250 * 1024 * 1024) }
  });

  app.get('/api/v2/capabilities', requireAuth, (_req, res) => {
    res.json({
      protocolVersion,
      encryptedResources: true,
      encryptedBlobs: true,
      contentBlindRealtime: true,
      legacyRuntime: false
    });
  });

  app.get('/api/v2/vaults/:vaultId/bootstrap', requireAuth, asyncRoute(async (req, res) => {
    const vault = await requireVaultAccess(req, res, { create: true });
    if (!vault) return;
    const envelopes = await all(
      `SELECT resourceId, resourceType, keyEpoch, lwwPhysicalMs, lwwLogical, lwwDeviceId,
              lwwOperationId, ciphertext, nonce, aad, ciphertextHash, schemaVersion
       FROM kept2_encrypted_resources
       WHERE vaultId = ? AND deleted = 0
       ORDER BY sequence ASC`,
      [vault.vaultId]
    );
    const keyGrants = await all(
      `SELECT grantId, vaultId, resourceId, resourceType, granteeId, grantPurpose, keyEpoch,
              wrappedKey, createdAt, revokedAt
       FROM kept2_key_grants
       WHERE vaultId = ? AND revokedAt IS NULL`,
      [vault.vaultId]
    );
    const cursor = await get('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM kept2_sync_changes WHERE vaultId = ?', [vault.vaultId]);
    res.json({
      envelopes: envelopes.map(rowToEnvelope),
      keyGrants,
      cursor: Number(cursor?.cursor || 0),
      serverTime: Date.now()
    });
  }));

  app.get('/api/v2/vaults/:vaultId/changes', requireAuth, asyncRoute(async (req, res) => {
    const vault = await requireVaultAccess(req, res);
    if (!vault) return;
    const cursor = Math.max(0, Number(req.query.cursor || 0) || 0);
    const limit = Math.min(Math.max(Number(req.query.limit || 500) || 500, 1), 2000);
    const rows = await all(
      `SELECT c.sequence, c.operation, c.resourceId, c.resourceType,
              r.keyEpoch, r.lwwPhysicalMs, r.lwwLogical, r.lwwDeviceId, r.lwwOperationId,
              r.ciphertext, r.nonce, r.aad, r.ciphertextHash, r.schemaVersion
       FROM kept2_sync_changes c
       LEFT JOIN kept2_encrypted_resources r
         ON r.vaultId = c.vaultId AND r.resourceId = c.resourceId
       WHERE c.vaultId = ? AND c.sequence > ?
       ORDER BY c.sequence ASC
       LIMIT ?`,
      [vault.vaultId, cursor, limit]
    );
    const max = await get('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM kept2_sync_changes WHERE vaultId = ?', [vault.vaultId]);
    res.json({
      changes: rows.map(row => ({
        sequence: row.sequence,
        operation: row.operation,
        resourceId: row.resourceId,
        resourceType: row.resourceType,
        envelope: row.operation === 'delete' ? null : rowToEnvelope(row)
      })),
      cursor: rows.length ? Number(rows[rows.length - 1].sequence) : cursor,
      hasMore: rows.length === limit && Number(rows[rows.length - 1].sequence) < Number(max?.cursor || 0),
      serverTime: Date.now()
    });
  }));

  app.post('/api/v2/vaults/:vaultId/mutations', requireAuth, asyncRoute(async (req, res) => {
    const vault = await requireVaultAccess(req, res, { create: true });
    if (!vault) return;
    const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : [];
    const results = await withDatabaseTransaction(async () => {
      const output = [];
      for (const mutation of mutations) {
        output.push(await applyMutation(vault.vaultId, mutation));
      }
      return output;
    });
    res.json(results);
  }));

  app.post('/api/v2/vaults/:vaultId/blobs/:blobId', requireAuth, upload.single('blob'), asyncRoute(async (req, res) => {
    const vault = await requireVaultAccess(req, res, { create: true });
    if (!vault) return;
    const blobId = safeOpaqueId(req.params.blobId);
    const ciphertextHash = String(req.body?.ciphertextHash || '').trim();
    if (!blobId || !req.file || !ciphertextHash) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'blobId, blob, and ciphertextHash are required.' });
    }
    const finalDir = path.join(kept2BlobDir, vault.vaultId);
    fs.mkdirSync(finalDir, { recursive: true });
    const storedFilename = `${blobId}.bin`;
    const finalPath = path.join(finalDir, storedFilename);
    fs.renameSync(req.file.path, finalPath);
    await run(
      `INSERT INTO kept2_blobs
       (vaultId, blobId, storedFilename, ciphertextHash, byteLength, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vaultId, blobId) DO UPDATE SET
         storedFilename = excluded.storedFilename,
         ciphertextHash = excluded.ciphertextHash,
         byteLength = excluded.byteLength,
         updatedAt = excluded.updatedAt`,
      [vault.vaultId, blobId, storedFilename, ciphertextHash, req.file.size, new Date().toISOString(), new Date().toISOString()]
    );
    res.status(201).json({ ok: true, blobId, ciphertextHash });
  }));

  app.get('/api/v2/vaults/:vaultId/blobs/:blobId', requireAuth, asyncRoute(async (req, res) => {
    const vault = await requireVaultAccess(req, res);
    if (!vault) return;
    const blobId = safeOpaqueId(req.params.blobId);
    if (!blobId) return res.status(400).json({ error: 'Invalid blob id.' });
    const blob = await get('SELECT * FROM kept2_blobs WHERE vaultId = ? AND blobId = ?', [vault.vaultId, blobId]);
    if (!blob) return res.status(404).json({ error: 'Blob not found.' });
    res.type('application/octet-stream').sendFile(path.join(kept2BlobDir, vault.vaultId, blob.storedFilename));
  }));

  async function requireVaultAccess(req, res, options = {}) {
    const vaultId = safeOpaqueId(req.params.vaultId);
    if (!vaultId) {
      res.status(400).json({ error: 'Invalid vault id.' });
      return null;
    }
    let vault = await get('SELECT * FROM kept2_vaults WHERE vaultId = ? AND ownerUserId = ?', [vaultId, req.user.id]);
    if (!vault && options.create) {
      const now = new Date().toISOString();
      await run(
        `INSERT OR IGNORE INTO kept2_vaults (vaultId, ownerUserId, protocolVersion, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        [vaultId, req.user.id, protocolVersion, now, now]
      );
      vault = await get('SELECT * FROM kept2_vaults WHERE vaultId = ? AND ownerUserId = ?', [vaultId, req.user.id]);
    }
    if (!vault) {
      res.status(404).json({ error: 'Vault not found.' });
      return null;
    }
    return vault;
  }

  async function applyMutation(vaultId, mutation) {
    const operationId = safeOpaqueId(mutation.operationId);
    if (!operationId) return { ok: false, operationId: '', error: 'Invalid operationId.' };
    const existing = await get('SELECT * FROM kept2_mutation_receipts WHERE vaultId = ? AND operationId = ?', [vaultId, operationId]);
    const mutationHash = sha256(JSON.stringify({
      mutationType: mutation.mutationType,
      resourceId: mutation.resourceId,
      payload: mutation.payload,
      lww: mutation.lww
    }));
    if (existing) {
      if (existing.mutationHash !== mutationHash) return { ok: false, operationId, error: 'Operation id was reused with different payload.' };
      return { ok: true, operationId, skipped: true, sequence: existing.sequence };
    }
    const type = String(mutation.mutationType || '');
    const resourceId = safeOpaqueId(mutation.resourceId);
    if (!resourceId) return { ok: false, operationId, error: 'Invalid resourceId.' };
    let sequence;
    if (type === 'resource.upsert') {
      const envelope = mutation.payload?.envelope || mutation.payload;
      const valid = validateEnvelope(resourceId, envelope);
      if (!valid.ok) return { ok: false, operationId, error: valid.error };
      await run(
        `INSERT INTO kept2_encrypted_resources
         (vaultId, resourceId, resourceType, keyEpoch, lwwPhysicalMs, lwwLogical, lwwDeviceId,
          lwwOperationId, ciphertext, nonce, aad, ciphertextHash, schemaVersion, deleted, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(vaultId, resourceId) DO UPDATE SET
           resourceType = excluded.resourceType,
           keyEpoch = excluded.keyEpoch,
           lwwPhysicalMs = excluded.lwwPhysicalMs,
           lwwLogical = excluded.lwwLogical,
           lwwDeviceId = excluded.lwwDeviceId,
           lwwOperationId = excluded.lwwOperationId,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           aad = excluded.aad,
           ciphertextHash = excluded.ciphertextHash,
           schemaVersion = excluded.schemaVersion,
           deleted = 0,
           updatedAt = excluded.updatedAt`,
        [
          vaultId,
          resourceId,
          envelope.resourceType,
          Number(envelope.keyEpoch || 1),
          Number(envelope.lww?.physicalMs || 0),
          Number(envelope.lww?.logical || 0),
          String(envelope.lww?.deviceId || ''),
          String(envelope.lww?.operationId || ''),
          String(envelope.ciphertext || ''),
          String(envelope.nonce || ''),
          JSON.stringify(envelope.aad || {}),
          String(envelope.ciphertextHash || ''),
          Number(envelope.schemaVersion || 1),
          new Date().toISOString()
        ]
      );
      sequence = await recordChange(vaultId, resourceId, envelope.resourceType, 'upsert');
    } else if (type === 'resource.delete') {
      const resourceType = String(mutation.payload?.resourceType || 'note.content');
      await run('UPDATE kept2_encrypted_resources SET deleted = 1, updatedAt = ? WHERE vaultId = ? AND resourceId = ?',
        [new Date().toISOString(), vaultId, resourceId]);
      sequence = await recordChange(vaultId, resourceId, resourceType, 'delete');
    } else if (type === 'keyGrant.upsert') {
      const grant = mutation.payload?.grant || mutation.payload;
      const grantId = safeOpaqueId(grant?.grantId);
      if (!grantId) return { ok: false, operationId, error: 'Invalid grantId.' };
      await run(
        `INSERT INTO kept2_key_grants
         (grantId, vaultId, resourceId, resourceType, granteeId, grantPurpose, keyEpoch, wrappedKey, createdAt, revokedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(grantId) DO UPDATE SET
           wrappedKey = excluded.wrappedKey,
           keyEpoch = excluded.keyEpoch,
           revokedAt = excluded.revokedAt`,
        [
          grantId,
          vaultId,
          safeOpaqueId(grant.resourceId),
          String(grant.resourceType || ''),
          String(grant.granteeId || ''),
          String(grant.grantPurpose || ''),
          Number(grant.keyEpoch || 1),
          String(grant.wrappedKey || ''),
          String(grant.createdAt || new Date().toISOString()),
          grant.revokedAt || null
        ]
      );
      sequence = await recordChange(vaultId, grantId, 'keyGrant', 'upsert');
    } else if (type === 'keyGrant.revoke') {
      await run('UPDATE kept2_key_grants SET revokedAt = ? WHERE vaultId = ? AND grantId = ?',
        [new Date().toISOString(), vaultId, resourceId]);
      sequence = await recordChange(vaultId, resourceId, 'keyGrant', 'delete');
    } else {
      return { ok: false, operationId, error: 'Unsupported mutation type.' };
    }
    await run(
      'INSERT INTO kept2_mutation_receipts (vaultId, operationId, mutationHash, sequence, createdAt) VALUES (?, ?, ?, ?, ?)',
      [vaultId, operationId, mutationHash, sequence, new Date().toISOString()]
    );
    return { ok: true, operationId, sequence };
  }

  async function recordChange(vaultId, resourceId, resourceType, operation) {
    const result = await run(
      `INSERT INTO kept2_sync_changes (vaultId, resourceId, resourceType, operation, changedAt)
       VALUES (?, ?, ?, ?, ?)`,
      [vaultId, resourceId, resourceType, operation, new Date().toISOString()]
    );
    const sequence = Number(result.id);
    const vault = await get('SELECT ownerUserId FROM kept2_vaults WHERE vaultId = ?', [vaultId]);
    afterDatabaseCommit(() => broadcastRealtime([vault?.ownerUserId].filter(Boolean), {
      type: 'kept2-resource-changed',
      vaultId,
      resourceId,
      sequence
    }));
    return sequence;
  }
}

async function initKept2RelaySchema({ run }) {
  await run(`CREATE TABLE IF NOT EXISTS kept2_vaults (
    vaultId TEXT PRIMARY KEY,
    ownerUserId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    protocolVersion TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_encrypted_resources (
    vaultId TEXT NOT NULL REFERENCES kept2_vaults(vaultId) ON DELETE CASCADE,
    resourceId TEXT NOT NULL,
    resourceType TEXT NOT NULL,
    keyEpoch INTEGER NOT NULL DEFAULT 1,
    lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
    lwwLogical INTEGER NOT NULL DEFAULT 0,
    lwwDeviceId TEXT NOT NULL DEFAULT '',
    lwwOperationId TEXT NOT NULL DEFAULT '',
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    aad TEXT NOT NULL DEFAULT '{}',
    ciphertextHash TEXT NOT NULL,
    schemaVersion INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY(vaultId, resourceId)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_key_grants (
    grantId TEXT PRIMARY KEY,
    vaultId TEXT NOT NULL REFERENCES kept2_vaults(vaultId) ON DELETE CASCADE,
    resourceId TEXT NOT NULL,
    resourceType TEXT NOT NULL,
    granteeId TEXT NOT NULL,
    grantPurpose TEXT NOT NULL,
    keyEpoch INTEGER NOT NULL DEFAULT 1,
    wrappedKey TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    revokedAt TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_sync_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    vaultId TEXT NOT NULL REFERENCES kept2_vaults(vaultId) ON DELETE CASCADE,
    resourceId TEXT NOT NULL,
    resourceType TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
    changedAt TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_mutation_receipts (
    vaultId TEXT NOT NULL REFERENCES kept2_vaults(vaultId) ON DELETE CASCADE,
    operationId TEXT NOT NULL,
    mutationHash TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(vaultId, operationId)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_blobs (
    vaultId TEXT NOT NULL REFERENCES kept2_vaults(vaultId) ON DELETE CASCADE,
    blobId TEXT NOT NULL,
    storedFilename TEXT NOT NULL,
    ciphertextHash TEXT NOT NULL,
    byteLength INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY(vaultId, blobId)
  )`);
  await run('CREATE INDEX IF NOT EXISTS kept2_changes_vault_sequence_idx ON kept2_sync_changes(vaultId, sequence)');
  await run('CREATE INDEX IF NOT EXISTS kept2_grants_vault_resource_idx ON kept2_key_grants(vaultId, resourceId)');
}

function validateEnvelope(resourceId, envelope) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'Envelope is required.' };
  if (safeOpaqueId(envelope.resourceId) !== resourceId) return { ok: false, error: 'Envelope resourceId mismatch.' };
  if (!String(envelope.resourceType || '').trim()) return { ok: false, error: 'Envelope resourceType is required.' };
  if (!String(envelope.ciphertext || '').trim()) return { ok: false, error: 'Envelope ciphertext is required.' };
  if (!String(envelope.nonce || '').trim()) return { ok: false, error: 'Envelope nonce is required.' };
  if (!String(envelope.ciphertextHash || '').trim()) return { ok: false, error: 'Envelope ciphertextHash is required.' };
  return { ok: true };
}

function rowToEnvelope(row) {
  return {
    resourceId: row.resourceId,
    resourceType: row.resourceType,
    keyEpoch: Number(row.keyEpoch || 1),
    lww: {
      physicalMs: Number(row.lwwPhysicalMs || 0),
      logical: Number(row.lwwLogical || 0),
      deviceId: row.lwwDeviceId || '',
      operationId: row.lwwOperationId || ''
    },
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    aad: safeJson(row.aad, {}),
    ciphertextHash: row.ciphertextHash,
    schemaVersion: Number(row.schemaVersion || 1)
  };
}

function safeOpaqueId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id)) return '';
  return id;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = { initKept2RelaySchema, mountKept2Relay };
