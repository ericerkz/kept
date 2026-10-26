const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

for (const mode of ['PUT', 'PATCH', 'sync-v1', 'sync-v2']) {
  test(`collaborator background changes reach the owner through ${mode}`, async () => {
    const fixture = await startFixture();
    const password = 'isolated-background-test-password';
    let ownerToken;
    let sequence = 0;
    async function request(path, body, method = body ? 'POST' : 'GET', token = ownerToken, status = 200) {
      const response = await fetch(`${fixture.origin}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      assert.equal(response.status, status, await response.clone().text());
      return status === 204 ? null : response.json();
    }
    try {
      await request('/setup/admin', { username: 'owner', displayName: 'Owner', password }, 'POST', undefined, 201);
      ownerToken = (await request('/auth/login', { username: 'owner', password })).token;
      const collaborator = await request('/users', { username: 'collaborator', displayName: 'Collaborator', password }, 'POST', ownerToken, 201);
      const collaboratorToken = (await request('/auth/login', { username: 'collaborator', password })).token;
      const note = await request('/notes', {
        noteTitle: 'Shared appearance', noteBody: 'Keep this content', bgColor: '#fff8b8',
        bgImage: '', binder: 'Owner binder', labels: [], images: [], checkBoxes: [], pinned: true
      }, 'POST', ownerToken, 201);
      await request(`/notes/${note.id}/collaborators`, { userIds: [collaborator.id] }, 'PUT');
      const before = await request(`/notes/${note.id}`);
      const cursor = (await request('/sync/changes?cursor=0')).cursor;
      async function save(background, token = collaboratorToken, denied = false) {
        const payload = {
          ...before, ...background, archived: true, trashed: true, binder: 'Changed binder',
          locked: true, lockSalt: 'changed-salt', lockHash: 'changed-hash',
          labels: [{ name: 'Changed label', added: true }], isCbox: true
        };
        if (!mode.startsWith('sync')) {
          return request(`/notes/${note.id}`, payload, mode, token, denied ? 404 : 204);
        }
        const operationId = `background-${++sequence}`;
        const response = await request('/sync/mutations', {
          ...(mode === 'sync-v2' ? { protocolVersion: 2 } : {}),
          mutations: [{ type: 'note.upsert', syncId: before.syncId, operationId, payload,
            lww: { physicalMs: Date.now() + sequence, logical: sequence, deviceId: 'background-test', operationId } }]
        }, 'POST', token);
        assert.equal(response.results[0].ok, !denied, JSON.stringify(response.results[0]));
      }
      const background = { bgColor: '#cbf0f8', bgImage: 'url(/assets/images/backgrounds/travel.svg)' };
      await save(background);
      for (const token of [ownerToken, collaboratorToken]) {
        const saved = await request(`/notes/${note.id}`, undefined, 'GET', token);
        assert.equal(saved.bgColor, background.bgColor);
        assert.equal(saved.bgImage, background.bgImage);
        for (const field of ['ownerUserId', 'noteBody', 'archived', 'trashed', 'binder', 'locked', 'isCbox']) {
          assert.equal(saved[field], before[field], `${field} must retain its existing permissions/value`);
        }
        assert.deepEqual(saved.labels, before.labels);
      }
      const changes = await request(`/sync/changes?cursor=${cursor}`);
      const sharedChange = changes.changes.filter(change => change.resourceSyncId === before.syncId).at(-1);
      assert.equal(sharedChange.payload.bgColor, background.bgColor, 'owner sync receives the new colour');
      assert.equal(sharedChange.payload.bgImage, background.bgImage, 'owner sync receives the new background');
      await save({ bgColor: '', bgImage: '' });
      const cleared = await request(`/notes/${note.id}`);
      assert.equal(cleared.bgColor, '');
      assert.equal(cleared.bgImage, '');
      assert.equal(cleared.pinned, true, 'the owner keeps their personal pin');
      await request(`/notes/${note.id}/collaborators`, { userIds: [] }, 'PUT');
      await save(background, collaboratorToken, true);
      assert.equal((await request(`/notes/${note.id}`)).bgColor, '', 'revoked collaborators cannot change appearance');
    } finally {
      await fixture.close();
    }
  });
}
