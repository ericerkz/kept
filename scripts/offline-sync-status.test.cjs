const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const rx = require('rxjs');

// Exercise the actual service with deterministic HTTP, storage and lifecycle
// boundaries. No browser, native build, server or wall-clock sleeps are needed.
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname,
  '../src/app/services/offline-sync.service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

class HttpErrorResponse extends Error {
  constructor({ status }) { super(`HTTP ${status}`); this.status = status; }
}
const failure = status => rx.throwError(() => new HttpErrorResponse({ status }));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, platform = 'web', initiallyOnline = true) {
  const clock = {
    now: 100000, nextId: 0, timers: new Map(),
    setTimeout(callback, delay) {
      const id = ++this.nextId;
      this.timers.set(id, { callback, at: this.now + delay });
      return id;
    },
    clearTimeout(id) { this.timers.delete(id); },
    async advance(ms) {
      const end = this.now + ms;
      for (;;) {
        const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        this.now = next[1].at;
        this.timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      this.now = end;
      await settle();
    }
  };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const navigator = { onLine: initiallyOnline };
  const callbacks = new Map();
  const app = {
    async addListener(event, callback) {
      callbacks.set(event, callback);
      return { remove: async () => callbacks.delete(event) };
    }
  };
  let sequence = 0;
  const queued = [];
  const store = {
    partition: id => `account:${id}`,
    ensureServerWorkspace: async partition => ({id:partition,partition,generation:'test',status:'active',protocolVersion:1}),
    patchWorkspace: async () => {},
    reconcile: async (_workspace,input) => { for (const result of input.results || []) if (result.ok) { const entry=(input.sent || []).find(entry=>entry.operationId === result.operationId); if(entry) await store.removeOutbox([entry.key]); } },
    purgePartition: async () => {},
    getSyncState: async () => ({ cursor: 1, serverOffsetMs: 0 }),
    setSyncState: async () => {},
    listNotes: async () => [{ id: 1, syncId: 'baseline', noteTitle: 'Existing note' }],
    replaceSnapshot: async () => {},
    listOutbox: async () => [...queued],
    nextStamp: () => ({ operationId: `op-${++sequence}`, physicalMs: clock.now, logical: 0, deviceId: 'test' }),
    enqueue: async (partition, type, syncId, payload, lww) => queued.push({
      key: lww.operationId, operationId:lww.operationId, partition, type, syncId, payload, lww
    }),
    removeOutbox: async keys => {
      for (let i = queued.length - 1; i >= 0; i--) if (keys.includes(queued[i].key)) queued.splice(i, 1);
    }
  };
  const auth = {
    workspace:{ready:Promise.resolve()},
    currentUser$: new rx.BehaviorSubject(null),
    get currentUser() { return this.currentUser$.value; },
    authHeaders: () => ({})
  };
  const requests = [];
  let respond = (method, _url, body) => rx.of(method === 'POST'
    ? { results: body.mutations.map(() => ({ ok: true })), serverTime: clock.now }
    : { changes: [], cursor: 1, hasMore: false, serverTime: clock.now });
  const http = Object.fromEntries(['get', 'post'].map(method => [method, (url, body) => rx.defer(() => {
    requests.push({ method: method.toUpperCase(), url, body, at: clock.now });
    return respond(method.toUpperCase(), url, body);
  })]));
  const errors = [];
  const sandbox = {
    exports: {}, navigator, window, document,
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    Date: { now: () => clock.now }, queueMicrotask,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name === '@angular/common/http') return { HttpErrorResponse };
      if (name === '@capacitor/core') return {
        Capacitor: { isNativePlatform: () => platform !== 'web', isPluginAvailable: () => platform !== 'web' },
        registerPlugin: () => app
      };
      if (name === 'rxjs') return rx;
      if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
      throw new Error(`Unexpected runtime import: ${name}`);
    }
  };
  vm.runInNewContext(source, sandbox);
  const service = new sandbox.exports.OfflineSyncService(http, auth, store, { run: work => work() });
  const states = [];
  service.state$.subscribe(state => states.push(state));
  t.after(() => service.ngOnDestroy());
  return {
    service, states, store, queued, requests, clock, navigator, window, document, callbacks, errors,
    respond: handler => { respond = handler; },
    login: async () => { auth.currentUser$.next({ id: 1 }); await settle(); },
    logout: async () => { auth.currentUser$.next(null); await settle(); },
    emit: event => window.dispatchEvent(new Event(event))
  };
}

test('outages stay offline through queued saves and capped 5/15/30-second retries', async t => {
  const h = harness(t);
  h.respond(() => failure(0));
  await h.login();
  assert.equal(h.service.state$.value, 'offline');
  h.states.length = 0;
  await h.service.enqueue('note.upsert', 'note-one', { noteTitle: 'Keep me' });
  await h.service.enqueue('note.upsert', 'note-two', { noteTitle: 'And me' });
  assert.equal(h.requests.length, 1, 'autosaves must not bypass recovery backoff');
  await h.clock.advance(4999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  await h.clock.advance(14999);
  assert.equal(h.requests.length, 2);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 3);
  assert.equal(h.service.isConnectionDegraded(), true, 'outage must outlast the temporary 10-second timeout');
  await h.service.enqueue('note.upsert', 'note-three', {});
  for (let i = 0; i < 3; i++) await h.clock.advance(30000);
  assert.equal(h.requests.length, 6);
  assert.equal(h.queued.length, 3, 'failed requests must retain outgoing edits');
  assert.ok(h.states.every(state => state === 'offline'));
  assert.equal(h.clock.timers.size, 1);
});

test('physical offline suppresses retries; online recovery waits for the server', async t => {
  const h = harness(t);
  await h.login();
  h.navigator.onLine = false;
  h.emit('offline');
  await h.service.enqueue('note.upsert', 'note-one', {});
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
  h.respond(() => failure(503));
  h.states.length = 0;
  h.navigator.onLine = true;
  h.emit('online');
  await settle();
  assert.equal(h.requests.length, 2, 'online should retry immediately');
  assert.ok(h.states.every(state => state === 'offline'));
  assert.equal(h.service.state$.value, 'offline');
});

for (const [platform, status] of [['ios', -1], ['android', 0]]) {
  for (const alreadyOpen of [true, false]) {
    test(`${platform}: ${alreadyOpen ? 'connection loss while open' : 'reopening without service'} stays offline`, async t => {
      const h = harness(t, platform);
      if (alreadyOpen) await h.login();
      h.respond(() => failure(status));
      h.states.length = 0;
      // Native WebViews can continue reporting onLine=true without emitting an
      // offline event. The failed HTTP request must identify the outage itself.
      if (alreadyOpen) await h.service.syncNow();
      else await h.login();
      assert.equal(h.service.state$.value, 'offline');
      assert.ok(!h.states.includes('error'));
      h.states.length = 0;
      await h.service.enqueue('note.upsert', 'offline-edit', { noteTitle: 'Preserved' });
      await h.clock.advance(5000);
      h.callbacks.get('resume')();
      await settle();
      assert.ok(h.states.every(state => state === 'offline'));
      assert.equal(h.queued.length, 1);
      assert.equal(h.errors.length, 0);
      h.respond((method, _url, body) => rx.of(method === 'POST'
        ? { results: body.mutations.map(() => ({ ok: true })), serverTime: h.clock.now }
        : { changes: [], cursor: 2, hasMore: false, serverTime: h.clock.now }));
      h.emit('online');
      await settle();
      assert.equal(h.service.state$.value, 'saved');
      assert.equal(h.queued.length, 0);
    });
  }
}

test('iOS: reopening with onLine=false makes no requests and shows offline immediately', async t => {
  const h = harness(t, 'ios', false);
  await h.login();
  await h.service.enqueue('note.upsert', 'offline-edit', {});
  h.callbacks.get('resume')();
  await settle();
  assert.ok(h.states.every(state => state === 'offline'));
  assert.equal(h.requests.length, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.queued.length, 1);
});

test('real recovery changes to syncing only after a response, then drains the queue', async t => {
  const h = harness(t);
  h.respond(() => failure(504));
  await h.login();
  await h.service.enqueue('note.upsert', 'note-one', { noteTitle: 'Offline edit' });
  const upload = new rx.Subject();
  const changes = new rx.Subject();
  h.respond(method => method === 'POST' ? upload : changes);
  h.states.length = 0;
  h.emit('online');
  await settle();
  assert.equal(h.service.state$.value, 'offline', 'attempting a request proves nothing');
  upload.next({ results: [{ ok: true }], serverTime: h.clock.now });
  await settle();
  assert.equal(h.service.state$.value, 'syncing');
  assert.equal(h.queued.length, 0);
  changes.next({ changes: [], cursor: 2, hasMore: false, serverTime: h.clock.now });
  await settle();
  assert.equal(h.service.state$.value, 'saved');
  assert.deepEqual(h.states, ['syncing', 'saved']);
  assert.equal(h.clock.timers.size, 0);
  const count = h.requests.length;
  await h.clock.advance(60000);
  assert.equal(h.requests.length, count, 'successful recovery cancels retry timers');
});

test('initial bootstrap intent survives an outage and deferred load requests', async t => {
  const h = harness(t);
  h.store.listNotes = async () => [];
  h.respond(() => failure(0));
  await h.login();
  assert.equal(h.requests[0].url, '/api/sync/bootstrap');
  await h.service.syncNow({ bootstrapIfEmpty: true });
  let replaced = 0;
  const reconcile = h.store.reconcile;
  h.store.reconcile = async (...args) => { if(args[1].snapshot) replaced++; return reconcile(...args); };
  h.respond((_method, url) => rx.of(url.endsWith('/bootstrap')
    ? { notes: [], reminders: [], attachments: [], cursor: 1, serverTime: h.clock.now }
    : { changes: [], cursor: 1, hasMore: false, serverTime: h.clock.now }));
  await h.clock.advance(5000);
  assert.deepEqual(h.requests.map(request => request.url), [
    '/api/sync/bootstrap', '/api/sync/bootstrap', '/api/sync/changes'
  ]);
  assert.equal(replaced, 1);
  assert.equal(h.service.state$.value, 'saved');
});

test('a real authentication failure during recovery stops outage retries', async t => {
  const h = harness(t);
  h.respond(() => failure(0));
  await h.login();
  h.respond(() => failure(401));
  await h.clock.advance(5000);
  assert.equal(h.service.state$.value, 'error');
  assert.equal(h.clock.timers.size, 0);
});

for (const platform of ['android', 'ios']) {
  test(`${platform}: resume retries immediately and concurrent lifecycle signals coalesce`, async t => {
    const h = harness(t, platform);
    h.respond(() => failure(502));
    await h.login();
    const response = new rx.Subject();
    h.respond(() => response);
    h.callbacks.get('resume')();
    h.callbacks.get('appStateChange')({ isActive: true });
    h.emit('online');
    h.document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.service.state$.value, 'offline');
    response.next({ changes: [], cursor: 2, hasMore: false, serverTime: h.clock.now });
    await settle();
    assert.equal(h.service.state$.value, 'saved');
    assert.equal(h.requests.length, 2, 'duplicate resume signals must not schedule a second sync');
  });
}

test('timeouts remain offline, and late responses do not announce recovery', async t => {
  const h = harness(t);
  const hung = new rx.Subject();
  h.respond(() => hung);
  await h.login();
  await h.clock.advance(12000);
  assert.equal(h.service.state$.value, 'offline');
  const retry = new rx.Subject();
  h.respond(() => retry);
  h.states.length = 0;
  await h.clock.advance(5000);
  await h.clock.advance(12000);
  assert.equal(h.requests.length, 2);
  hung.next({ changes: [], cursor: 2, hasMore: false });
  retry.next({ changes: [], cursor: 2, hasMore: false });
  await settle();
  assert.ok(h.states.every(state => state === 'offline'));
});

for (const status of [400, 401, 403, 500]) {
  test(`HTTP ${status} requires attention and does not schedule outage retries`, async t => {
    const h = harness(t);
    h.respond(() => failure(status));
    await h.login();
    assert.equal(h.service.state$.value, 'error');
    assert.equal(h.clock.timers.size, 0);
  });
}

test('storage failures while physically offline require attention', async t => {
  const h = harness(t);
  await h.login();
  h.navigator.onLine = false;
  h.emit('offline');
  h.store.enqueue = async () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(h.service.enqueue('note.upsert', 'note-one', {}), /QuotaExceededError/);
  assert.equal(h.service.state$.value, 'error');
  h.emit('offline');
  assert.equal(h.service.state$.value, 'error', 'another offline signal must not hide a storage failure');
});

test('an offline event cannot disguise a local persistence error in an in-flight sync', async t => {
  const h = harness(t);
  const response = new rx.Subject();
  h.respond(() => response);
  await h.login();
  h.navigator.onLine = false;
  h.emit('offline');
  h.store.reconcile = async () => { throw new Error('Storage unavailable'); };
  response.next({ changes: [], cursor: 2, hasMore: false });
  await settle();
  assert.equal(h.service.state$.value, 'error');
  assert.equal(h.clock.timers.size, 0);
});

test('new edits during an in-flight sync are flushed in a coalesced follow-up', async t => {
  const h = harness(t);
  const response = new rx.Subject();
  h.respond(() => response);
  await h.login();
  await h.service.enqueue('note.upsert', 'note-one', { noteTitle: 'During sync' });
  h.respond((method, _url, body) => rx.of(method === 'POST'
    ? { results: body.mutations.map(() => ({ ok: true })), serverTime: h.clock.now }
    : { changes: [], cursor: 2, hasMore: false, serverTime: h.clock.now }));
  response.next({ changes: [], cursor: 2, hasMore: false, serverTime: h.clock.now });
  await settle();
  assert.equal(h.queued.length, 0);
  assert.deepEqual(h.requests.map(request => request.method), ['GET', 'POST', 'GET']);
  assert.equal(h.service.state$.value, 'saved');
});

test('logout and service teardown cancel retries and lifecycle listeners', async t => {
  const h = harness(t, 'android');
  h.respond(() => failure(0));
  await h.login();
  await h.logout();
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
  h.service.ngOnDestroy();
  assert.equal(h.callbacks.size, 0);
  h.emit('online');
  h.document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(h.requests.length, 1);
});
