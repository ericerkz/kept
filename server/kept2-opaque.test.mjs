import assert from 'node:assert/strict';
import test from 'node:test';
import opaque from '@serenity-kit/opaque';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3').verbose();
const {
  createDatabaseOpaqueBroker,
  createKept2OpaqueBroker,
  initKept2OpaqueSchema
} = require('./kept2/opaque-auth.js');

function openMemoryDb() {
  const db = new sqlite3.Database(':memory:');
  return {
    db,
    run: (sql, args = []) => new Promise((resolve, reject) => {
      db.run(sql, args, error => error ? reject(error) : resolve());
    }),
    get: (sql, args = []) => new Promise((resolve, reject) => {
      db.get(sql, args, (error, row) => error ? reject(error) : resolve(row));
    }),
    close: () => new Promise((resolve, reject) => {
      db.close(error => error ? reject(error) : resolve());
    })
  };
}

test('kept2 OPAQUE broker completes registration and login without server-held password', async () => {
  await opaque.ready;
  const broker = createKept2OpaqueBroker();
  const userIdentifier = 'user:42';
  const password = 'correct horse battery staple';

  const startedRegistration = opaque.client.startRegistration({ password });
  const { registrationResponse } = await broker.createRegistrationResponse({
    userIdentifier,
    registrationRequest: startedRegistration.registrationRequest
  });
  const finishedRegistration = opaque.client.finishRegistration({
    clientRegistrationState: startedRegistration.clientRegistrationState,
    registrationResponse,
    password
  });
  await broker.storeRegistrationRecord({
    userIdentifier,
    registrationRecord: finishedRegistration.registrationRecord
  });

  const startedLogin = opaque.client.startLogin({ password });
  const { loginId, loginResponse } = await broker.startLogin({
    userIdentifier,
    startLoginRequest: startedLogin.startLoginRequest
  });
  const finishedLogin = opaque.client.finishLogin({
    clientLoginState: startedLogin.clientLoginState,
    loginResponse,
    password
  });
  assert.ok(finishedLogin?.finishLoginRequest);
  const serverFinish = await broker.finishLogin({
    loginId,
    finishLoginRequest: finishedLogin.finishLoginRequest
  });
  assert.equal(serverFinish.userIdentifier, userIdentifier);
  assert.equal(serverFinish.sessionKey, finishedLogin.sessionKey);
  assert.equal(finishedRegistration.exportKey, finishedLogin.exportKey);
});

test('kept2 OPAQUE broker rejects login completion with the wrong password', async () => {
  await opaque.ready;
  const broker = createKept2OpaqueBroker();
  const userIdentifier = 'user:43';
  const password = 'right password';

  const startedRegistration = opaque.client.startRegistration({ password });
  const { registrationResponse } = await broker.createRegistrationResponse({
    userIdentifier,
    registrationRequest: startedRegistration.registrationRequest
  });
  const finishedRegistration = opaque.client.finishRegistration({
    clientRegistrationState: startedRegistration.clientRegistrationState,
    registrationResponse,
    password
  });
  await broker.storeRegistrationRecord({
    userIdentifier,
    registrationRecord: finishedRegistration.registrationRecord
  });

  const startedLogin = opaque.client.startLogin({ password: 'wrong password' });
  const { loginResponse } = await broker.startLogin({
    userIdentifier,
    startLoginRequest: startedLogin.startLoginRequest
  });
  const finishedLogin = opaque.client.finishLogin({
    clientLoginState: startedLogin.clientLoginState,
    loginResponse,
    password: 'wrong password'
  });
  assert.equal(finishedLogin, undefined);
});

test('kept2 database OPAQUE broker persists registrations and server setup', async () => {
  await opaque.ready;
  const database = openMemoryDb();
  try {
    await initKept2OpaqueSchema({ run: database.run });
    const firstBroker = createDatabaseOpaqueBroker({ get: database.get, run: database.run });
    const userIdentifier = 'user:44';
    const password = 'stored server setup survives';

    const startedRegistration = opaque.client.startRegistration({ password });
    const { registrationResponse } = await firstBroker.createRegistrationResponse({
      userIdentifier,
      registrationRequest: startedRegistration.registrationRequest
    });
    const finishedRegistration = opaque.client.finishRegistration({
      clientRegistrationState: startedRegistration.clientRegistrationState,
      registrationResponse,
      password
    });
    await firstBroker.storeRegistrationRecord({
      userIdentifier,
      registrationRecord: finishedRegistration.registrationRecord
    });

    const secondBroker = createDatabaseOpaqueBroker({ get: database.get, run: database.run });
    const startedLogin = opaque.client.startLogin({ password });
    const { loginId, loginResponse } = await secondBroker.startLogin({
      userIdentifier,
      startLoginRequest: startedLogin.startLoginRequest
    });
    const finishedLogin = opaque.client.finishLogin({
      clientLoginState: startedLogin.clientLoginState,
      loginResponse,
      password
    });
    const serverFinish = await secondBroker.finishLogin({
      loginId,
      finishLoginRequest: finishedLogin.finishLoginRequest
    });

    assert.equal(serverFinish.userIdentifier, userIdentifier);
    assert.equal(serverFinish.sessionKey, finishedLogin.sessionKey);
    assert.equal(finishedRegistration.exportKey, finishedLogin.exportKey);
  } finally {
    await database.close();
  }
});
