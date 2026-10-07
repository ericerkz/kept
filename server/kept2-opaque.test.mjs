import assert from 'node:assert/strict';
import test from 'node:test';
import opaque from '@serenity-kit/opaque';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKept2OpaqueBroker } = require('./kept2/opaque-auth.js');

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
