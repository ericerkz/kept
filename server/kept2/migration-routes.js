const { createLegacySnapshot, createMigrationPlan } = require('./migration');

function mountKept2MigrationRoutes(app, {
  all,
  get,
  attachmentPath,
  imagePath,
  imageMimeType,
  asyncRoute,
  requireAuth,
  sourceVersion
}) {
  app.get('/api/v2/migration/preview', requireAuth, asyncRoute(async (req, res) => {
    const snapshot = await buildLegacySnapshotForUser({
      all,
      userId: req.user.id,
      sourceVersion
    });
    const vaultId = sanitizeVaultId(req.query.vaultId) || undefined;
    const plan = createMigrationPlan(snapshot, {
      vaultId,
      deviceId: `migration-user-${req.user.id}`
    });

    res.json({
      destructive: false,
      cutoverReady: false,
      sourceVersion: snapshot.sourceVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      counts: snapshot.counts,
      vaultId: plan.vaultId,
      resourceCount: plan.resources.length,
      resourcesByType: summarizeResourcesByType(plan.resources),
      warnings: plan.warnings,
      nextStep: 'Create and unlock a Kept 2 vault before encrypted cutover.'
    });
  }));

  app.get('/api/v2/migration/export', requireAuth, asyncRoute(async (req, res) => {
    const snapshot = await buildLegacySnapshotForUser({
      all,
      userId: req.user.id,
      sourceVersion
    });
    const vaultId = sanitizeVaultId(req.query.vaultId) || undefined;
    const plan = createMigrationPlan(snapshot, {
      vaultId,
      deviceId: `migration-user-${req.user.id}`
    });

    res.json({
      destructive: false,
      sourceVersion: snapshot.sourceVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      counts: snapshot.counts,
      vaultId: plan.vaultId,
      resources: plan.resources,
      warnings: plan.warnings,
      limitations: [
        'This Kept 2.0 migration export contains legacy plaintext over the authenticated connection so the unlocked local vault can encrypt it client-side.',
        'Attachment bytes are fetched separately by syncId during import so they can be stored and re-synced as encrypted blobs.',
        'Legacy note image bytes are fetched separately by filename during import so image notes remain available in the local encrypted vault.'
      ]
    });
  }));

  app.get('/api/v2/migration/attachments/:syncId/blob', requireAuth, asyncRoute(async (req, res) => {
    const syncId = sanitizeResourceId(req.params.syncId);
    if (!syncId) return res.status(400).json({ error: 'Invalid attachment syncId.' });
    const attachment = await get(
      `SELECT na.*
         FROM note_attachments na
         JOIN notes n ON n.id = na.noteId
        WHERE na.syncId = ? AND n.ownerUserId = ?`,
      [syncId, req.user.id]
    );
    if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

    const filePath = attachmentPath(attachment.storedFilename);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  }));

  app.get('/api/v2/migration/images/:filename/blob', requireAuth, asyncRoute(async (req, res) => {
    const filename = sanitizeImageFilename(req.params.filename);
    if (!filename) return res.status(400).json({ error: 'Invalid image filename.' });
    const image = await get(
      `SELECT ni.*
         FROM note_images ni
         JOIN notes n ON n.id = ni.noteId
        WHERE ni.storedFilename = ? AND n.ownerUserId = ?
        LIMIT 1`,
      [filename, req.user.id]
    );
    if (!image) return res.status(404).json({ error: 'Image not found.' });

    const filePath = imagePath(filename);
    if (!filePath) return res.status(404).json({ error: 'Image file not found.' });
    res.setHeader('Content-Type', image.mimeType || imageMimeType(filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  }));
}

async function buildLegacySnapshotForUser({ all, userId, sourceVersion }) {
  const notes = await all(
    `SELECT n.*,
            CASE WHEN up.noteId IS NULL THEN n.pinned ELSE 1 END AS pinned,
            COALESCE(unp.sortOrder, n.sortOrder) AS sortOrder,
            COALESCE(uvs.completedChecklistCollapsed, 0) AS completedChecklistCollapsed
       FROM notes n
       LEFT JOIN user_pins up ON up.noteId = n.id AND up.userId = ?
       LEFT JOIN user_note_positions unp ON unp.noteId = n.id AND unp.userId = ?
       LEFT JOIN user_note_view_states uvs ON uvs.noteId = n.id AND uvs.userId = ?
      WHERE n.ownerUserId = ?
      ORDER BY n.id`,
    [userId, userId, userId, userId]
  );
  const noteIds = notes.map(note => Number(note.id)).filter(Number.isFinite);
  const noteFilter = sqlIn('n.id', noteIds);
  const noteFilterDirect = sqlIn('noteId', noteIds);

  const reminders = noteIds.length ? await all(
    `SELECT r.*,
            r.dueAtUtc AS dueAt,
            CASE
              WHEN r.latitude IS NOT NULL AND r.longitude IS NOT NULL THEN 'location'
              ELSE 'time'
            END AS kind
       FROM reminders r
       JOIN notes n ON n.id = r.noteId
      WHERE ${noteFilter.sql}
      ORDER BY r.id`,
    noteFilter.params
  ) : [];
  const attachments = noteIds.length ? await all(
    `SELECT na.*
       FROM note_attachments na
       JOIN notes n ON n.id = na.noteId
      WHERE ${noteFilter.sql}
      ORDER BY na.id`,
    noteFilter.params
  ) : [];
  const noteImages = noteIds.length ? await all(
    `SELECT ni.*
       FROM note_images ni
      WHERE ${noteFilterDirect.sql}
      ORDER BY ni.id`,
    noteFilterDirect.params
  ) : [];
  const collaborators = noteIds.length ? await all(
    `SELECT nc.*
       FROM note_collaborators nc
      WHERE ${noteFilterDirect.sql}
      ORDER BY nc.noteId, nc.userId`,
    noteFilterDirect.params
  ) : [];
  const labels = await all(
    'SELECT * FROM labels WHERE userId = ? ORDER BY id',
    [userId]
  );

  return createLegacySnapshot({
    sourceVersion,
    notes,
    reminders,
    attachments,
    noteImages,
    labels,
    collaborators
  });
}

function summarizeResourcesByType(resources) {
  const summary = {};
  for (const resource of resources || []) {
    summary[resource.resourceType] = (summary[resource.resourceType] || 0) + 1;
  }
  return summary;
}

function sanitizeVaultId(value) {
  const vaultId = String(value || '').trim();
  if (!vaultId) return '';
  return /^[A-Za-z0-9._:-]{1,180}$/.test(vaultId) ? vaultId : '';
}

function sanitizeResourceId(value) {
  const resourceId = String(value || '').trim();
  if (!resourceId) return '';
  return /^[A-Za-z0-9._:-]{1,180}$/.test(resourceId) ? resourceId : '';
}

function sanitizeImageFilename(value) {
  const filename = String(value || '').trim();
  if (!filename) return '';
  return /^[0-9]+-[a-f0-9]{24}\.(png|jpe?g|gif|webp)$/i.test(filename) ? filename : '';
}

function sqlIn(column, values) {
  if (!values.length) return { sql: '1 = 0', params: [] };
  return {
    sql: `${column} IN (${values.map(() => '?').join(',')})`,
    params: values
  };
}

module.exports = {
  mountKept2MigrationRoutes,
  buildLegacySnapshotForUser,
  summarizeResourcesByType
};
