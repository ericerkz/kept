const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/app/services/device-server-move.service.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

function harness({ native = true, pluginAvailable = true, offering = true, local = true, values = new Map(), storageFails = false, signupError } = {}) {
  const calls = [];
  const workspace = {
    ready: Promise.resolve(), canUseLocal: native, isLocal: local,
    local: local ? { id: 'device-library', generation: 'original', status: 'active' } : null
  };
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => { if (storageFails) throw new Error('Storage unavailable'); values.set(key, value); },
    removeItem: key => values.delete(key)
  };
  const plugin = {
    getOffering: async () => ({ available: offering }),
    start: async () => {
      calls.push(['signup', JSON.parse(values.get('kept_device_cloud_move'))]);
      if (signupError) throw signupError;
    }
  };
  const exports = {};
  vm.runInNewContext(source, { exports, localStorage: storage, require(name) {
    if (name === '@angular/core') return { Injectable: () => target => target };
    if (name === '@capacitor/core') return {
      Capacitor: { isNativePlatform: () => native, isPluginAvailable: () => pluginAvailable },
      registerPlugin: () => plugin
    };
    throw new Error(`Unexpected dependency ${name}`);
  } });
  const service = new exports.DeviceServerMoveService(workspace, { navigate: async (...args) => { calls.push(['navigate', ...args]); return true; } });
  return { service, workspace, calls, values };
}

test('invitation is claimed only once for the install, including after relaunch or a restored/different library', async () => {
  const first = harness(); await first.service.ready;
  assert.equal(first.service.claimInvite(), true);
  assert.equal(first.service.claimInvite(), false);
  const reopened = harness({ values: first.values }); await reopened.service.ready;
  reopened.workspace.local = { id: 'restored-library', generation: 'new', status: 'active' };
  assert.equal(reopened.service.claimInvite(), false);
  const freshInstall = harness(); await freshInstall.service.ready;
  assert.equal(freshInstall.service.claimInvite(), true);
});

test('web, connected accounts, unavailable native offers and frozen libraries never claim the invitation', async () => {
  for (const options of [{ native: false }, { local: false }, { pluginAvailable: false }, { offering: false }]) {
    const h = harness(options); await h.service.ready;
    assert.equal(h.service.claimInvite(), false);
    assert.equal(h.values.size, 0);
  }
  const h = harness(); await h.service.ready;
  h.workspace.local.status = 'frozen';
  assert.equal(h.service.claimInvite(), false);
});

test('storage failure suppresses the invitation and prevents signup without a durable transfer intent', async () => {
  const h = harness({ storageFails: true }); await h.service.ready;
  assert.equal(h.service.claimInvite(), false);
  await assert.rejects(h.service.startCloud(), /Storage unavailable/);
  assert.deepEqual(h.calls, []);
});

test('signup durably saves the source before opening native UI; reload resumes transfer without signing up again', async () => {
  const first = harness(); await first.service.ready;
  const original = JSON.stringify(first.workspace.local);
  await first.service.startCloud();
  assert.equal(JSON.stringify(first.workspace.local), original);
  assert.equal(first.calls[0][0], 'signup');
  assert.equal(first.calls[0][1].workspaceId, 'device-library');
  assert.equal(await first.service.resumeCloudMove(), false, 'no premature migration before the native reload');
  const reopened = harness({ values: first.values }); await reopened.service.ready;
  assert.equal(reopened.service.claimInvite(), false, 'do not show a promotion during transfer');
  assert.equal(await reopened.service.resumeCloudMove(), true);
  assert.equal(reopened.calls.length, 1);
  assert.equal(reopened.calls[0][0], 'navigate');
  assert.equal(reopened.calls[0][1][0], '/settings');
  assert.equal(reopened.calls[0][2].queryParams.resume, '1');
  assert.equal(await reopened.service.resumeCloudMove(), false);
  assert.equal(reopened.service.pendingCloudMove, true, 'keep resumability until successful transfer or explicit cancellation');
});

test('cancelled signup clears the transfer intent while leaving the source library untouched', async () => {
  const h = harness({ signupError: new Error('Cancelled') }); await h.service.ready;
  await assert.rejects(h.service.startCloud(), /Cancelled/);
  assert.equal(h.service.pendingCloudMove, false);
  assert.equal(h.workspace.local.status, 'active');
  const reopened = harness({ values: h.values });
  assert.equal(await reopened.service.resumeCloudMove(), false);
});

test('a transfer intent cannot resume into a different workspace or generation; explicit cancel stays cancelled', async () => {
  const first = harness(); await first.service.startCloud();
  for (const field of ['id', 'generation']) {
    const reopened = harness({ values: new Map(first.values) });
    reopened.workspace.local[field] = 'different';
    assert.equal(reopened.service.pendingCloudMove, false);
    assert.equal(await reopened.service.resumeCloudMove(), false);
    assert.deepEqual(reopened.calls, []);
  }
  const cancelled = harness({ values: first.values });
  cancelled.service.cancelCloudMove();
  assert.equal(await cancelled.service.resumeCloudMove(), false);
  assert.equal(cancelled.service.pendingCloudMove, false);
});

test('banner entry opens the Cloud migration route, without changing workspace selection', async () => {
  const h = harness();
  await h.service.openCloudMove();
  assert.equal(h.calls[0][1][0], '/settings');
  assert.equal(h.calls[0][2].queryParams.move, 'cloud');
  assert.equal(h.workspace.isLocal, true);
  assert.equal(h.workspace.local.status, 'active');
});
