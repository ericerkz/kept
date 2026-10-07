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

function safeUserIdentifier(value) {
  return /^[A-Za-z0-9._:@-]{1,180}$/.test(String(value || ''));
}

module.exports = { createKept2OpaqueBroker };
