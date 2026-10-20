const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const sqlite3 = require('sqlite3');

async function startFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kept-session-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dbPath = path.join(directory, 'test.sqlite');
  let child;
  let output = '';
  async function start() {
    child = spawn(process.execPath, ['server/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), DATA_DIR: directory, SQLITE_PATH: dbPath,
        UPLOAD_DIR: path.join(directory, 'uploads'), ATTACHMENT_DIR: path.join(directory, 'attachments'),
        TAKEOUT_TMP_DIR: path.join(directory, 'imports'), KEPT_TEST_MODE: '1',
        BASE_URL: origin, KEPT_CORS_ORIGINS: `http://localhost:${port}`, KEPT_CORS_ALLOW_ALL: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(origin + '/api/setup/status')).ok) return; } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Test server failed to start: ' + output);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  try { await start(); } catch (error) { await stop(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    origin, directory,
    async restart() { await stop(); await start(); },
    async sql(statement, args = []) {
      const db = new sqlite3.Database(dbPath);
      try {
        return await new Promise((resolve, reject) => db.all(statement, args, (error, rows) => error ? reject(error) : resolve(rows)));
      } finally { await new Promise(resolve => db.close(resolve)); }
    },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); }
  };
}
module.exports = { startFixture };
