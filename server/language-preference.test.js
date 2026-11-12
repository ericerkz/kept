const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeLanguage}=require('../shared/language-preference');
const {startFixture}=require('../test-support/session-fixture.cjs');
test('language preference accepts canonical and future languages without accepting paths or objects',()=>{
  assert.equal(normalizeLanguage('system'),'system');assert.equal(normalizeLanguage('pt-br'),'pt-BR');
  assert.equal(normalizeLanguage('he'),'he');
  for(const value of ['',null,{},[],1,'../en','<script>','en_US','x'.repeat(65)])assert.equal(normalizeLanguage(value),null);
});
test('account and sync language choices persist independently and old clients preserve them',async()=>{
  const fixture=await startFixture();let token,counter=0;
  async function request(route,body,method=body?'POST':'GET',status=200) {
    const response=await fetch(fixture.origin+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,status,await response.clone().text());return response.json();
  }
  async function send(payload){return (await request('/sync/mutations',{protocolVersion:2,mutations:[{type:'preferences.patch',syncId:'account-preferences',payload,operationId:`language-${++counter}`,lww:{physicalMs:Date.now()+counter,logical:counter,deviceId:'language-test',operationId:`language-${counter}`}}]})).results[0];}
  try {
    const credentials={username:'translator',password:'test-language-password'};
    await request('/setup/admin',credentials,'POST',201);token=(await request('/auth/login',credentials)).token;
    const before=await request('/users/me/preferences');assert.equal(before.language,'system');assert.equal(before.languagePreferencesSupported,true);
    assert.equal((await request('/users/me/preferences',{language:'pt-br'},'PATCH')).language,'pt-BR');
    await request('/users/me/preferences',{language:'../../etc'},'PATCH',400);
    assert.equal((await request('/users/me/preferences',{showPastReminders:true},'PATCH')).language,'pt-BR');
    assert.equal((await send({language:'he'})).ok,true);
    const boot=await request('/sync/bootstrap?protocolVersion=2');assert.equal(boot.preferences[0].language,'he');
    assert.equal((await send({theme:'dark'})).canonical.language,'he');
    assert.equal((await send({language:{malformed:true}})).ok,false);
    await fixture.restart();assert.equal((await request('/users/me/preferences')).language,'he');
    await request('/users',{username:'another',password:'another-test-password'},'POST',201);
    token=(await request('/auth/login',{username:'another',password:'another-test-password'})).token;
    assert.equal((await request('/users/me/preferences')).language,'system');
  } finally {await fixture.close();}
});
