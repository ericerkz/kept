const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rx = require('rxjs');

function harness(platform = 'web') {
  const navigations = [], notifications = [], workerListeners = new Map();
  const mutations = [];
  const window = { Notification: true, focus() { this.focused = true; } };
  const navigator = { serviceWorker: { addEventListener: (name, callback) => workerListeners.set(name, callback) } };
  class Notification {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
    close() { this.closed = true; }
  }
  const noteHtml = {
    sanitizeNoteHtml: value => value,
    createNoteHtmlContainer: () => ({ innerHTML: '', get textContent() { return this.innerHTML; } })
  };
  function load(file) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
    }).outputText;
    vm.runInNewContext(source, { exports, window, navigator, Notification, console, setTimeout,
      require(name) {
        if (name === '@angular/core') return { Injectable: () => target => target, Component: () => target => target, ViewChild: () => () => {} };
        if (name === '@capacitor/core') return { Capacitor: { getPlatform: () => platform }, registerPlugin: () => ({}) };
        if (name === 'rxjs') return rx;
        if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
        if (name.endsWith('/note-html')) return noteHtml;
        if (name.endsWith('/uuid')) return { createUuid: () => 'test-id' };
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
    return exports;
  }
  const { ReminderService } = load('src/app/services/reminder.service.ts');
  const service = Object.create(ReminderService.prototype);
  service.router = { url: '/', navigate: async (commands, options) => { navigations.push(JSON.parse(JSON.stringify({ commands, options }))); return true; } };
  service.zone = { run: callback => callback() };
  service.firedReminder$ = new rx.Subject();
  service.trackDisplayedNotification = () => {};
  service.isAndroidNativeNotificationAvailable = () => false;
  service.dismissFiredReminder = async id => mutations.push(['dismiss', id]);
  service.update = async (id, update) => mutations.push(['update', id, update]);
  const { ReminderNotificationComponent } = load('src/app/components/reminder/reminder-notification.component.ts');
  const component = new ReminderNotificationComponent(service);
  component.ngOnInit();
  service.listenForServiceWorkerMessages();
  return { service, component, navigations, notifications, workerListeners, mutations, window };
}

const reminder = { reminderId: 8, noteId: 42, title: 'Reminder', body: 'Full note text', source: 'local' };

test('reminder navigation preserves the current notes view and accepts local note ids; other screens open the overview', async () => {
  const h = harness();
  for (const route of ['/', '/archive?note=7', '/label/Work', '/binder/Recipes', '/reminders']) {
    h.service.router.url = route;
    assert.equal(await h.service.openReminderNote(42), true);
    assert.deepEqual(h.navigations.at(-1), { commands: [], options: { queryParams: { note: 42 }, queryParamsHandling: 'merge' } });
  }
  h.service.router.url = '/settings';
  await h.service.openReminderNote(-2);
  assert.deepEqual(h.navigations.at(-1), { commands: ['/'], options: { queryParams: { note: -2 } } });
  const before = h.navigations.length;
  for (const id of [null, undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await h.service.openReminderNote(id), false);
  }
  assert.equal(h.navigations.length, before);
});

test('opening the banner navigates and hides it without dismissing/snoozing; failed navigation retains it', async () => {
  const h = harness();
  h.service.firedReminder$.next(reminder);
  await h.component.openNote();
  assert.equal(h.navigations.at(-1).options.queryParams.note, 42);
  assert.equal(h.component.notification, null);
  assert.deepEqual(h.mutations, []);
  h.service.firedReminder$.next(reminder);
  h.service.router.navigate = async () => false;
  await h.component.openNote();
  assert.equal(h.component.notification.noteId, 42);
});

test('page notification clicks focus Kept and open their own note without clearing a newer banner', async () => {
  const h = harness();
  h.service.firedReminder$.next(reminder);
  const first = h.notifications[0];
  h.service.firedReminder$.next({ ...reminder, reminderId: 9, noteId: 43 });
  await first.onclick();
  assert.equal(h.window.focused, true);
  assert.equal(first.closed, true);
  assert.equal(h.navigations.at(-1).options.queryParams.note, 42);
  assert.equal(h.component.notification.noteId, 43);
  assert.deepEqual(h.mutations, []);
  await h.notifications[1].onclick();
  assert.equal(h.navigations.at(-1).options.queryParams.note, 43);
  assert.equal(h.component.notification, null);
});

test('service-worker click messages navigate through Angular; native and push delivery do not create duplicate page notifications', async () => {
  const h = harness();
  h.workerListeners.get('message')({ data: { type: 'notification-click', payload: { noteId: 42 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.navigations.at(-1).options.queryParams.note, 42);
  for (const source of ['native', 'sw-push']) h.service.firedReminder$.next({ ...reminder, source });
  assert.equal(h.notifications.length, 0);
  const android = harness('android');
  android.service.firedReminder$.next(reminder);
  assert.equal(android.notifications.length, 0);
  assert.equal(android.component.notification.noteId, 42);
});

function workerHarness(clients = []) {
  const listeners = new Map(), opened = [], displayed = [];
  const self = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    location: { origin: 'https://kept.test' },
    clients: { matchAll: async () => clients, openWindow: async url => opened.push(url) },
    registration: { showNotification: async (title, options) => displayed.push({ title, options }) }
  };
  vm.runInNewContext(fs.readFileSync('src/kept-push-sw.js', 'utf8'), { self, URL });
  async function click(data) {
    let completion;
    listeners.get('notificationclick')({ notification: { data, close() {} }, waitUntil(promise) { completion = promise; } });
    await completion;
  }
  return { click, opened, displayed, listeners };
}

test('push clicks open the correct note in a new window and safely fall back for standalone/invalid reminders', async () => {
  const h = workerHarness();
  await h.click({ noteId: 42, url: '/' });
  assert.equal(h.opened[0], 'https://kept.test/?note=42');
  for (const noteId of [null, 0, -1, 'bad', 1.5]) await h.click({ noteId, url: 'https://untrusted.test/' });
  assert.ok(h.opened.slice(1).every(url => url === 'https://kept.test/'));
});

test('push clicks focus an existing window and message Angular without reloading an editor', async () => {
  const events = [];
  const client = { focus: async () => events.push('focus'), postMessage: data => events.push(JSON.parse(JSON.stringify(data))) };
  const h = workerHarness([client]);
  await h.click({ noteId: 42 });
  assert.deepEqual(events, ['focus', { type: 'notification-click', payload: { noteId: 42 } }]);
  assert.deepEqual(h.opened, []);
  const unavailable = workerHarness([{ focus: async () => { throw new Error('Window closed'); } }]);
  await unavailable.click({ noteId: 42 });
  assert.deepEqual(unavailable.opened, ['https://kept.test/?note=42']);
});

test('server push payload links to the note and retains the existing native deep link', () => {
  const source = fs.readFileSync('server/server.js', 'utf8').match(/function buildReminderPushPayload\(reminder\) \{[\s\S]*?\n\}/)[0];
  const context = { plainText: value => String(value || '') };
  vm.runInNewContext(source, context);
  const payload = JSON.parse(context.buildReminderPushPayload({ id: 8, noteId: 42, title: 'Reminder', body: 'Body' }));
  assert.equal(payload.url, '/?note=42');
  assert.equal(payload.deepLink, 'kept://note/42');
  assert.equal(payload.reminderId, 8);
  assert.equal(JSON.parse(context.buildReminderPushPayload({ id: 9, noteId: null })).url, '/');
});
