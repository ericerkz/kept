const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), rx = require('rxjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
const MINUTE = 60000, DAY = 86400000;
const ending = { kind: 'ending', endsAt: '2030-01-05T00:30:00.000Z', deletesAt: '2030-04-05T00:30:00.000Z', dismissible: true, actionUrl: 'https://provider.test/account' };
const managed = { managed: true, providerName: 'Acme Hosting', accountUrl: ending.actionUrl, externalBackups: true, quotaBytes: 1000, notice: ending };

function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    timers, setNow: value => now = value,
    setTimeout: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = end; await settle();
    }
  };
}

function load(file, runtime) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText, {
    exports, ...runtime,
    require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target, Component: () => target => target };
      if (name === 'rxjs') return rx;
      if (name === '@capacitor/core') return runtime.capacitor;
      if (name.endsWith('/environment')) return { environment: { apiUrl: runtime.api || 'https://server.test/api' } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return exports;
}

function serviceHarness(t, platform = 'web', local = false, api) {
  const time = clock(), window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const requests = [], callbacks = new Map(); let respond = () => rx.of(managed);
  const capacitor = {
    Capacitor: { isNativePlatform: () => platform !== 'web', isPluginAvailable: () => true },
    registerPlugin: () => ({ addListener: async (event, callback) => { callbacks.set(event, callback); return { remove: async () => callbacks.delete(event) }; } })
  };
  const { ManagedHostingService } = load('src/app/services/managed-hosting.service.ts', { api, window, document, capacitor, Date: time.Date });
  const service = new ManagedHostingService({ get: url => rx.defer(() => { requests.push(url); return respond(); }) },
    { isLocal: local, workspace: { ready: Promise.resolve() } }, { run: fn => fn() });
  t.after(() => service.ngOnDestroy());
  return { service, requests, window, document, callbacks, time, respond: fn => respond = fn };
}

for (const platform of ['web', 'ios', 'android']) test(`${platform}: startup and foreground refreshes are coalesced and limited to 30 minutes`, async t => {
  const h = serviceHarness(t, platform); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.service.info$.value.notice.kind, 'ending');
  h.window.dispatchEvent(new Event('focus')); h.document.dispatchEvent(new Event('visibilitychange'));
  h.callbacks.get('resume')?.(); h.callbacks.get('appStateChange')?.({ isActive: true });
  await h.service.info(); assert.equal(h.requests.length, 1);
  h.time.setNow(30 * MINUTE);
  const pending = new rx.Subject(); h.respond(() => pending);
  h.window.dispatchEvent(new Event('focus')); h.document.dispatchEvent(new Event('visibilitychange'));
  h.callbacks.get('resume')?.(); h.callbacks.get('appStateChange')?.({ isActive: true });
  assert.equal(h.requests.length, 2);
  pending.next({ ...managed, notice: null }); pending.complete(); await settle();
  assert.equal(h.service.info$.value.notice, null);
  h.service.ngOnDestroy(); h.time.setNow(60 * MINUTE); h.window.dispatchEvent(new Event('focus'));
  assert.equal(h.requests.length, 2); assert.equal(h.callbacks.size, 0);
});

test('foreground failures preserve the last notice and are throttled; older servers normalize to no notice', async t => {
  const h = serviceHarness(t); await settle(); h.time.setNow(30 * MINUTE);
  h.respond(() => rx.throwError(() => new Error('Offline')));
  await h.service.info(); assert.equal(h.service.info$.value.notice.kind, 'ending');
  await h.service.info(); assert.equal(h.requests.length, 2);
  h.time.setNow(60 * MINUTE); const { notice, ...legacy } = managed;
  h.respond(() => rx.of(legacy)); await h.service.info(); assert.equal(h.service.info$.value.notice, null);
});

test('device-only libraries make no hosting requests on startup or resume', async t => {
  const h = serviceHarness(t, 'android', true); await settle();
  h.callbacks.get('resume')?.(); h.time.setNow(DAY); h.window.dispatchEvent(new Event('focus'));
  assert.equal((await h.service.info()).managed, false); assert.equal(h.requests.length, 0);
  const fresh = serviceHarness(t, 'ios', false, '/api'); await settle();
  assert.equal((await fresh.service.info()).managed, false); assert.equal(fresh.requests.length, 0);
});

function bannerHarness(t, { values = new Map(), time = clock(), api, admin = true, local = false, locale, timeZone } = {}) {
  const window = Object.assign(new EventTarget(), { scrollY: 0 }), info$ = new rx.BehaviorSubject(managed);
  const geometry = { documentTop: 5, toolbarBottom: 88, rootBottom: 0, rootPosition: 'static', toolbarPosition: 'fixed' };
  const styles = new Map();
  const toolbar = { get position() { return geometry.toolbarPosition; }, getBoundingClientRect: () => ({ bottom: geometry.toolbarBottom }) };
  const navbar = { get position() { return geometry.rootPosition; }, querySelector: () => toolbar, getBoundingClientRect: () => ({ bottom: geometry.rootBottom }) };
  const host = { getBoundingClientRect: () => ({ top: geometry.documentTop - window.scrollY }), style: { setProperty: (name, value) => styles.set(name, value) } };
  const auth = { isAdmin: admin, isLocal: local, accessChanges$: new rx.BehaviorSubject(null) };
  const { ManagedNoticeBannerComponent } = load('src/app/components/managed-notice-banner/managed-notice-banner.component.ts', {
    api, window, document: { querySelector: () => navbar }, getComputedStyle: element => ({ position: element.position }),
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    requestAnimationFrame: callback => time.setTimeout(callback, 0), cancelAnimationFrame: time.clearTimeout,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    Intl: { DateTimeFormat: class { constructor(_locale, options) { return new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) }); } } }
  });
  const component = new ManagedNoticeBannerComponent(auth, { info$, info: async () => info$.value }, { run: fn => fn() }, { nativeElement: host });
  component.ngOnInit(); t.after(() => component.ngOnDestroy());
  return { component, auth, info$, time, values, window, geometry, styles };
}

test('admins and members get the correct ending and payment-problem messages', t => {
  const h = bannerHarness(t); const date = h.component.formatDate(ending.endsAt);
  assert.equal(h.component.message, `Your Acme Hosting plan ends on ${date}. Download a backup, or keep your plan.`);
  h.auth.isAdmin = false;
  assert.equal(h.component.message, `This server’s plan ends on ${date}. Save a copy of your notes, or ask the server’s owner.`);
  h.info$.next({ ...managed, notice: { ...ending, kind: 'payment_problem', endsAt: null, deletesAt: null } });
  assert.equal(h.component.message, 'This server’s plan has a payment problem. Ask the server’s owner to update it.');
  h.auth.isAdmin = true;
  assert.equal(h.component.message, 'Acme Hosting couldn’t take your last payment. Update your billing to keep this server.');
});

test('dismissal survives reopening, expires after 24 hours and is scoped to the server', async t => {
  const first = bannerHarness(t); first.component.dismiss(); assert.equal(first.component.notice, null);
  first.component.ngOnDestroy();
  const reopened = bannerHarness(t, { values: first.values, time: first.time }); assert.equal(reopened.component.notice, null);
  await reopened.time.advance(DAY - 1); assert.equal(reopened.component.notice, null);
  await reopened.time.advance(1); assert.equal(reopened.component.notice.kind, 'ending');
  reopened.component.dismiss();
  const differentServer = bannerHarness(t, { values: first.values, api: 'https://different.test/api' });
  assert.equal(differentServer.component.notice.kind, 'ending');
});

test('all provider notices remain dismissible, while changed deadlines show a new notice', async t => {
  const h = bannerHarness(t); h.component.dismiss();
  h.info$.next({ ...managed, notice: { ...ending, dismissible: false } });
  assert.equal(h.component.notice, null, 'provider flags cannot bypass a device dismissal');
  await h.time.advance(DAY); assert.ok(h.component.notice);
  h.component.dismiss(); assert.equal(h.component.notice, null, 'even a provider-marked non-dismissible notice can be dismissed');
  h.info$.next({ ...managed, notice: { ...ending, endsAt: '2030-01-06T12:00:00.000Z' } });
  assert.ok(h.component.notice);
  h.info$.next({ ...managed, notice: null }); assert.equal(h.component.notice, null);
});

test('mobile toolbar clearance keeps the banner below the navbar and does not grow when scrolled', async t => {
  const h = bannerHarness(t); h.component.ngAfterViewInit(); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '83px');
  assert.ok(h.geometry.documentTop + Number.parseFloat(h.styles.get('--plan-notice-clearance')) >= h.geometry.toolbarBottom);
  h.window.scrollY = 200; h.window.dispatchEvent(new Event('resize')); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '83px');
  h.geometry.toolbarBottom = 64; h.window.dispatchEvent(new Event('resize')); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '59px', 'rotation uses the current toolbar size');
  h.component.dismiss(); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '0px', 'dismissing removes the reserved space');
});

test('native safe-area clearance is not doubled and desktop navbars need no extra space', async t => {
  const h = bannerHarness(t);
  Object.assign(h.geometry, { documentTop: 100, rootBottom: 120, toolbarBottom: 120, rootPosition: 'fixed', toolbarPosition: 'sticky' });
  h.component.ngAfterViewInit(); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '20px', 'only the missing native clearance is added');
  h.geometry.documentTop = 140; h.window.dispatchEvent(new Event('resize')); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '0px', 'an already-cleared parent needs no padding');
  Object.assign(h.geometry, { documentTop: 0, rootPosition: 'static', toolbarPosition: 'sticky' });
  h.window.dispatchEvent(new Event('resize')); await h.time.advance(0);
  assert.equal(h.styles.get('--plan-notice-clearance'), '0px', 'normal desktop document flow stays unchanged');
});

test('self-hosted and device-only views never display the banner', t => {
  const local = bannerHarness(t, { local: true }); assert.equal(local.component.notice, null);
  const selfhost = bannerHarness(t); selfhost.info$.next({ ...managed, managed: false }); assert.equal(selfhost.component.notice, null);
});

test('dates use the viewer locale and time zone, including date changes across midnight', t => {
  for (const [locale, timeZone] of [['en-US', 'America/New_York'], ['fr-FR', 'Europe/Paris']]) {
    const h = bannerHarness(t, { locale, timeZone });
    const expected = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(ending.endsAt));
    assert.equal(h.component.formatDate(ending.endsAt), expected);
    assert.ok(h.component.message.includes(expected));
  }
});
