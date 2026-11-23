// Removing encryption publishes the readable note and all restored files in
// one database transaction. Until it commits, the old envelope and files remain
// authoritative. Multipart files are private/unlinked until that same commit.
function registerEncryptedNoteRemoval(app, deps) {
  const { requireAuth, asyncRoute, uploadAttachment, withDatabaseTransaction, getAccessibleNote,
    isEncryptedLock, parseEncryptedEnvelope, canonicalizeNotePayload, run, get, all, crypto,
    safeDownloadName, attachmentResponse, recordAttachmentSyncChange, removeFileAfterCommit,
    attachmentPath, storageQuota, afterDatabaseRollback, serverLwwStamp, storeEncryptedContent,
    syncNoteImagesForNote, broadcastNoteChange, dbNoteToApi } = deps;
  const digest = value => crypto.createHash('sha256').update(value || '').digest('hex');
  const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
  const cleanUploads = req => Promise.all((req.files || []).filter(file => file.path).map(file => storageQuota.remove(file.path)));

  app.post('/api/notes/:id/remove-encryption', requireAuth, asyncRoute(async (req, res, next) => {
    const note = await getAccessibleNote(Number(req.params.id), req.user.id);
    if (!note || note.ownerUserId !== req.user.id || req.mcpToken) return res.status(403).json({ error: 'Only the note owner can remove encryption in Kept.' });
    next();
  }), (req, res, next) => {
    uploadAttachment.array('files', 1000)(req, res, error => {
      if (!error) return next();
      cleanUploads(req).then(() => next(error), next);
    });
  }, asyncRoute(async (req, res) => {
    try {
      const saved = await withDatabaseTransaction(async () => {
        for (const file of req.files || []) afterDatabaseRollback(() => storageQuota.remove(file.path));
        const existing = await getAccessibleNote(Number(req.params.id), req.user.id);
        if (!existing || existing.ownerUserId !== req.user.id) fail(403, 'Only the note owner can remove encryption.');
        let input;
        try { input = JSON.parse(req.body.note); } catch { fail(400, 'Invalid restored note.'); }
        if (!isEncryptedLock(existing) || digest(existing.encryptedContent) !== input?.expectedEnvelopeHash) {
          fail(409, 'The note changed during restoration. Reopen it before removing its lock.');
        }
        if (typeof input.noteBody !== 'string' || !Array.isArray(input.checkBoxes) || !Array.isArray(input.images)
          || !Array.isArray(input.restoredFileIds) || !Array.isArray(input.attachments)) fail(400, 'The complete restored content is required.');
        const envelope = parseEncryptedEnvelope(existing.encryptedContent);
        const expected = new Set(envelope?.files || []);
        const restored = new Set(input.restoredFileIds);
        if (restored.size !== input.restoredFileIds.length || restored.size !== expected.size
          || [...expected].some(id => !restored.has(id))) fail(400, 'Every encrypted file must be restored before removing the lock.');
        if (input.attachments.length !== (req.files || []).length) fail(400, 'Restored attachments are missing.');
        const attachmentIds = new Set();
        for (const item of input.attachments) {
          if (!expected.has(item.sourceSyncId) || attachmentIds.has(item.sourceSyncId)) fail(400, 'Invalid restored attachment.');
          attachmentIds.add(item.sourceSyncId);
        }
        // Do not leave kept://file references without their key. The client has
        // uploaded images already; the standard linker validates their access.
        if (/kept:\/\/file\//.test(JSON.stringify([input.noteBody, input.checkBoxes, input.images]))) fail(400, 'Some images have not been restored.');
        const next = canonicalizeNotePayload({ ...dbNoteToApi(existing), noteBody: input.noteBody,
          checkBoxes: input.checkBoxes, images: input.images, locked: false, lockSalt: '', lockHash: '', encryptedContent: '' });
        const originals = await all("SELECT * FROM note_attachments WHERE noteId = ? AND lower(originalName) LIKE '%.keptenc'", [existing.id]);
        const now = new Date().toISOString();
        for (const file of req.files || []) {
          const stamp = serverLwwStamp();
          const inserted = await run(`INSERT INTO note_attachments
            (noteId, syncId, originalName, storedFilename, fileSize, mimeType, uploadedAt, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [existing.id, `attachment-${crypto.randomUUID()}`,
            safeDownloadName(file.originalname), file.filename, file.size, file.mimetype, now,
            stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId]);
          await recordAttachmentSyncChange(await get('SELECT * FROM note_attachments WHERE id = ?', [inserted.id]), 'upsert');
        }
        await run(`UPDATE notes SET noteBody = ?, checkBoxes = ?, images = ?, locked = 0, lockSalt = '', lockHash = '',
          updatedAt = ?, lastEditorUserId = ? WHERE id = ?`, [next.noteBody || '', JSON.stringify(next.checkBoxes || []),
          JSON.stringify(next.images || []), now, req.user.id, existing.id]);
        // The new files and content now exist in the same transaction. Only
        // after commit may the original encrypted files be physically removed.
        for (const row of originals) {
          const stamp = serverLwwStamp();
          await run('DELETE FROM note_attachments WHERE id = ?', [row.id]);
          await run("UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ? WHERE resourceType = 'attachment' AND resourceSyncId = ?", [now, row.syncId]);
          await recordAttachmentSyncChange({ ...row, lwwPhysicalMs: stamp.physicalMs, lwwLogical: stamp.logical,
            lwwDeviceId: stamp.deviceId, lwwOperationId: stamp.operationId }, 'delete');
          removeFileAfterCommit(attachmentPath(row.storedFilename));
        }
        await storeEncryptedContent(existing.id, next);
        await syncNoteImagesForNote(existing.id, existing.ownerUserId, next);
        await broadcastNoteChange(existing.id, 'updated');
        return { ...dbNoteToApi(await getAccessibleNote(existing.id, req.user.id)),
          attachments: (await all('SELECT * FROM note_attachments WHERE noteId = ?', [existing.id])).map(attachmentResponse) };
      });
      res.json(saved);
    } catch (error) {
      await cleanUploads(req);
      if (error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  }));
}
module.exports = { registerEncryptedNoteRemoval };
