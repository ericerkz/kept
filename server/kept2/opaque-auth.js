const crypto = require('crypto');
const opaque = require('@serenity-kit/opaque');

function createKept2OpaqueBroker(options = {}) {
  const serverSetup = options.serverSetup || opaque.server.createSetup();
  const records = options.records || new Map();
  const loginStates = options.loginStates || new Map();

  async function ready() {
    await opaque.ready;
  }

  return {
    serverSetup,

    async serverPublicKey() {
      await ready();
      return opaque.server.getPublicKey(serverSetup);
    },

    async createRegistrationResponse({ userIdentifier, registrationRequest }) {
      await ready();
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      if (!registrationRequest) throw new Error('registrationRequest is required.');
      return opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier,
        registrationRequest
      });
    },

    async storeRegistrationRecord({ userIdentifier, registrationRecord }) {
      await ready();
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      if (!registrationRecord) throw new Error('registrationRecord is required.');
      const now = new Date().toISOString();
      records.set(userIdentifier, {
        userIdentifier,
        registrationRecord,
        createdAt: records.get(userIdentifier)?.createdAt || now,
        updatedAt: now
      });
      return records.get(userIdentifier);
    },

    async startLogin({ userIdentifier, startLoginRequest }) {
      await ready();
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      const record = records.get(userIdentifier);
      if (!record) throw new Error('OPAQUE registration record not found.');
      const { loginResponse, serverLoginState } = opaque.server.startLogin({
        userIdentifier,
        registrationRecord: record.registrationRecord,
        serverSetup,
        startLoginRequest
      });
      const loginId = `opaque-login-${crypto.randomUUID()}`;
      loginStates.set(loginId, {
        userIdentifier,
        serverLoginState,
        createdAt: new Date().toISOString()
      });
      return { loginId, loginResponse };
    },

    async finishLogin({ loginId, finishLoginRequest }) {
      await ready();
      const state = loginStates.get(loginId);
      if (!state) throw new Error('OPAQUE login state not found.');
      loginStates.delete(loginId);
      const { sessionKey } = opaque.server.finishLogin({
        serverLoginState: state.serverLoginState,
        finishLoginRequest
      });
      return {
        userIdentifier: state.userIdentifier,
        sessionKey
      };
    }
  };
}

async function initKept2OpaqueSchema({ run }) {
  await run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_opaque_accounts (
    userIdentifier TEXT PRIMARY KEY,
    registrationRecord TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS kept2_opaque_login_states (
    loginId TEXT PRIMARY KEY,
    userIdentifier TEXT NOT NULL,
    serverLoginState TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  )`);
}

function createDatabaseOpaqueBroker({ get, run, serverSetup }) {
  let cachedServerSetup = serverSetup || null;

  async function resolveServerSetup() {
    await opaque.ready;
    if (cachedServerSetup) return cachedServerSetup;

    const row = await get('SELECT value FROM app_settings WHERE key = ?', ['kept2OpaqueServerSetup']);
    if (row?.value) {
      cachedServerSetup = row.value;
      return cachedServerSetup;
    }

    cachedServerSetup = opaque.server.createSetup();
    await run(
      'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
      ['kept2OpaqueServerSetup', cachedServerSetup]
    );
    return cachedServerSetup;
  }

  return {
    async serverPublicKey() {
      return opaque.server.getPublicKey(await resolveServerSetup());
    },

    async createRegistrationResponse({ userIdentifier, registrationRequest }) {
      await opaque.ready;
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      if (!registrationRequest) throw new Error('registrationRequest is required.');
      return opaque.server.createRegistrationResponse({
        serverSetup: await resolveServerSetup(),
        userIdentifier,
        registrationRequest
      });
    },

    async storeRegistrationRecord({ userIdentifier, registrationRecord }) {
      await opaque.ready;
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      if (!registrationRecord) throw new Error('registrationRecord is required.');
      const now = new Date().toISOString();
      const existing = await get('SELECT createdAt FROM kept2_opaque_accounts WHERE userIdentifier = ?', [userIdentifier]);
      await run(
        `INSERT INTO kept2_opaque_accounts (userIdentifier, registrationRecord, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(userIdentifier) DO UPDATE SET
           registrationRecord = excluded.registrationRecord,
           updatedAt = excluded.updatedAt`,
        [userIdentifier, registrationRecord, existing?.createdAt || now, now]
      );
      return { userIdentifier, createdAt: existing?.createdAt || now, updatedAt: now };
    },

    async startLogin({ userIdentifier, startLoginRequest }) {
      await opaque.ready;
      if (!safeUserIdentifier(userIdentifier)) throw new Error('Invalid OPAQUE user identifier.');
      const record = await get('SELECT registrationRecord FROM kept2_opaque_accounts WHERE userIdentifier = ?', [userIdentifier]);
      if (!record) throw new Error('OPAQUE registration record not found.');
      const { loginResponse, serverLoginState } = opaque.server.startLogin({
        userIdentifier,
        registrationRecord: record.registrationRecord,
        serverSetup: await resolveServerSetup(),
        startLoginRequest
      });
      const loginId = `opaque-login-${crypto.randomUUID()}`;
      const now = Date.now();
      await run(
        `INSERT INTO kept2_opaque_login_states (loginId, userIdentifier, serverLoginState, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?)`,
        [loginId, userIdentifier, serverLoginState, new Date(now).toISOString(), new Date(now + 5 * 60 * 1000).toISOString()]
      );
      return { loginId, loginResponse };
    },

    async finishLogin({ loginId, finishLoginRequest }) {
      await opaque.ready;
      const state = await get(
        'SELECT * FROM kept2_opaque_login_states WHERE loginId = ? AND expiresAt > ?',
        [loginId, new Date().toISOString()]
      );
      if (!state) throw new Error('OPAQUE login state not found.');
      await run('DELETE FROM kept2_opaque_login_states WHERE loginId = ?', [loginId]);
      const { sessionKey } = opaque.server.finishLogin({
        serverLoginState: state.serverLoginState,
        finishLoginRequest
      });
      return {
        userIdentifier: state.userIdentifier,
        sessionKey
      };
    }
  };
}

function mountKept2OpaqueRoutes(app, deps) {
  const { asyncRoute, get, run } = deps;
  const serverSetup = process.env.KEPT2_OPAQUE_SERVER_SETUP || null;
  const broker = createDatabaseOpaqueBroker({ get, run, serverSetup });

  app.get('/api/v2/opaque/server-public-key', asyncRoute(async (_req, res) => {
    res.json({ serverPublicKey: await broker.serverPublicKey() });
  }));

  app.post('/api/v2/opaque/registration-response', asyncRoute(async (req, res) => {
    const userIdentifier = String(req.body?.userIdentifier || '').trim();
    const registrationRequest = String(req.body?.registrationRequest || '');
    const response = await broker.createRegistrationResponse({ userIdentifier, registrationRequest });
    res.json(response);
  }));

  app.post('/api/v2/opaque/registration-record', asyncRoute(async (req, res) => {
    const userIdentifier = String(req.body?.userIdentifier || '').trim();
    const registrationRecord = String(req.body?.registrationRecord || '');
    await broker.storeRegistrationRecord({ userIdentifier, registrationRecord });
    res.status(201).json({ ok: true, userIdentifier });
  }));

  app.post('/api/v2/opaque/login/start', asyncRoute(async (req, res) => {
    const userIdentifier = String(req.body?.userIdentifier || '').trim();
    const startLoginRequest = String(req.body?.startLoginRequest || '');
    res.json(await broker.startLogin({ userIdentifier, startLoginRequest }));
  }));

  app.post('/api/v2/opaque/login/finish', asyncRoute(async (req, res) => {
    const loginId = String(req.body?.loginId || '').trim();
    const finishLoginRequest = String(req.body?.finishLoginRequest || '');
    const result = await broker.finishLogin({ loginId, finishLoginRequest });
    res.json({
      ok: true,
      userIdentifier: result.userIdentifier,
      sessionKeyHash: crypto.createHash('sha256').update(result.sessionKey).digest('hex')
    });
  }));
}

function safeUserIdentifier(value) {
  return /^[A-Za-z0-9._:@-]{1,180}$/.test(String(value || ''));
}

module.exports = {
  createDatabaseOpaqueBroker,
  createKept2OpaqueBroker,
  initKept2OpaqueSchema,
  mountKept2OpaqueRoutes
};
