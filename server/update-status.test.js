const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const comparison = source.slice(source.indexOf('function compareVersion('), source.indexOf('function fetchLatestRelease('));
const route = source.slice(
  source.indexOf("app.get('/api/admin/update-status',"),
  source.indexOf("app.post('/api/admin/update-status/dismiss',")
);

async function updateStatus(current, latest, dismissal = null) {
  let handler;
  let response;
  const context = {
    KEPT_VERSION: current,
    app: { get: (_path, ...handlers) => { handler = handlers.at(-1); } },
    requireAuth() {},
    requireAdmin() {},
    asyncRoute: fn => fn,
    createPerfTrace: () => ({ mark() {} }),
    getCachedLatestRelease: () => ({
      version: latest,
      url: `https://github.com/ericerkz/kept/releases/tag/v${latest}`,
      notes: 'Release notes',
      publishedAt: '2026-11-12T10:59:16Z'
    }),
    refreshLatestReleaseInBackground() {},
    get: async () => dismissal,
    updateCheckCache: { fetchedAt: Date.parse('2026-11-14T00:03:49Z'), error: null },
    sendJsonWithPerf: (_res, _trace, body) => { response = body; }
  };
  vm.runInNewContext(comparison + route, context);
  await handler({ user: { id: 1 } }, {});
  return response;
}

for (const [current, latest, outdated] of [
  ['1.9.4', '1.9.5', true],
  ['1.9.5', '1.9.6', true],
  ['1.9.5', '1.9.5', false],
  ['1.9.5', '1.9.4', false],
  ['1.9.9', '1.9.10', true],
  ['1.9.10', '1.9.9', false],
  ['1.9.99', '1.10.0', true],
  ['1.99.99', '2.0.0', true],
  ['v1.9.4', 'v1.9.5', true],
  ['1.9', '1.9.1', true],
  ['1.9.0', '1.9', false],
  ['1.9', '1.9.0', false]
]) {
  test(`update status for ${current} with release ${latest}: outdated=${outdated}`, async () => {
    const status = await updateStatus(current, latest);
    assert.equal(status.current, current);
    assert.equal(status.latest, latest);
    assert.equal(status.isOutdated, outdated);
    assert.equal(status.suppressed, false);
    assert.equal(status.checkError, null);
  });
}

test('a dismissed patch update stays outdated but its banner remains suppressed', async () => {
  const status = await updateStatus('1.9.4', '1.9.5', { forever: 1 });
  assert.equal(status.isOutdated, true);
  assert.equal(status.suppressed, true);
  assert.equal(status.dismissedForever, true);
});
