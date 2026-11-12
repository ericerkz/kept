const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rx = require('rxjs');
const messages = require('../test-support/i18n.cjs');
const { english } = messages;
function harness({ supported = true, local = false } = {}) {
  const exports = {}, values = new Map(), events = [];
  const manifest = { languages: [
    {code:'en',direction:'ltr'}, {code:'he',direction:'rtl'},
    {code:'fr',direction:'ltr'}, {code:'zh-Hant',direction:'ltr'}
  ] };
  const document = { documentElement:{}, visibilityState:'visible',baseURI:'https://localhost/',addEventListener(){} };
  const translate = {
    current:'en', setTranslation(){}, getCurrentLang(){return this.current;},
    use(language){if(this.failLanguage===language)return rx.throwError(()=>new Error('Translation unavailable'));this.current=language;return rx.of({});},
    instant(key,params={}) { const text = (this.current==='he' && key==='language.label' ? 'שפה' : english[key]) || key;
      return text.replace(/{{(\w+)}}/g, (_,name)=>String(params[name]??'')); }
  };
  const workspace = {ready:Promise.resolve(),local$:new rx.BehaviorSubject(local ? {preferences:{language:'system'}} : null)};
  const auth = {isLocal:local,currentUser:{id:1,language:'system',languagePreferencesSupported:supported},calls:[],
    async updateAccountPreferences(patch){this.calls.push(patch);if(this.fail)throw new Error('Storage unavailable');
      if(local)workspace.local$.next({preferences:patch});else{this.currentUser={...this.currentUser,...patch};this.currentUser$.next(this.currentUser);}}
  };
  auth.currentUser$=new rx.BehaviorSubject(auth.currentUser);
  class HttpClient {get(){return rx.of({'language.label':'שפה','language.system':''});}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/i18n/i18n.service.ts','utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,esModuleInterop:true}
  }).outputText,{exports,Intl,URL,document,navigator:{languages:['en-US'],language:'en-US'},
    localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},
    window:{addEventListener(){},dispatchEvent:event=>events.push(event)},CustomEvent:class {constructor(type,init){this.type=type;this.detail=init.detail;}},
    require(name){
      if(name==='@angular/core')return {Injectable:()=>target=>target};
      if(name==='@angular/common/http')return {HttpClient};
      if(name==='@ngx-translate/core')return {TranslateLoader:class{}};
      if(name==='rxjs')return rx;
      if(name.endsWith('/environment'))return {environment:{apiUrl:'https://server.example/api'}};
      if(name.endsWith('/en.json'))return english;
      if(name.endsWith('/languages.json'))return manifest;
      if(name==='./messages')return {...messages,installMessageRenderer(){}};
      throw new Error(`Unexpected import ${name}`);
    }});
  const service=new exports.I18nService(translate,auth,workspace,{run:callback=>callback()});
  return {service,auth,workspace,translate,document,exports,events,values};
}
test('system, regional fallback, all registered languages, explicit override and RTL resolve consistently',async()=>{
  const h=harness();await h.service.initialize();
  assert.equal(h.exports.resolveUiLanguage('system',['he-IL']).code,'he');
  assert.equal(h.exports.resolveUiLanguage('system',['zh-Hant-TW']).code,'zh-Hant');
  assert.equal(h.exports.resolveUiLanguage('en',['he']).code,'en');
  assert.equal(h.exports.resolveUiLanguage('fr',['fr']).code,'fr');
  assert.equal(h.exports.resolveUiLanguage('system',['fr-CA']).code,'fr');
  assert.equal(h.exports.resolveUiLanguage('system',['xx']).code,'en');
  await h.service.selectLanguage('he');
  assert.equal(h.document.documentElement.lang,'he');assert.equal(h.document.documentElement.dir,'rtl');
  assert.equal(h.service.text('language.label'),'שפה');
  assert.equal(h.auth.calls.length,1);assert.equal(h.auth.calls[0].language,'he');
  assert.equal(h.events.at(-1).detail.preference,'he');
  await h.service.selectLanguage('fr');assert.equal(h.auth.calls.length,2);
  assert.equal(h.document.documentElement.lang,'fr');
  await h.service.selectLanguage('xx');assert.equal(h.auth.calls.length,2);
});
test('a storage failure does not prevent localization or the app recovery screen from starting',async()=>{
  const h=harness();
  h.workspace.ready=Promise.reject(new Error('Device storage unavailable'));
  await h.service.initialize();
  assert.equal(h.document.documentElement.lang,'en');
});
test('an unavailable language falls back to English without losing the saved choice',async()=>{
  const h=harness();await h.service.initialize();h.translate.failLanguage='he';
  await h.service.selectLanguage('he');
  assert.equal(h.service.preference,'he');assert.equal(h.auth.currentUser.language,'he');
  assert.equal(h.document.documentElement.lang,'en');assert.equal(h.document.documentElement.dir,'ltr');
  assert.equal(h.service.saving,false);
});
test('local preferences save; failed saves restore the previous language; old servers use device-only fallback',async()=>{
  const local=harness({local:true});await local.service.initialize();await local.service.selectLanguage('he');
  assert.equal(local.auth.calls[0].language,'he');
  local.auth.fail=true;await assert.rejects(local.service.selectLanguage('en'));
  assert.equal(local.service.preference,'he');assert.equal(local.service.saving,false);
  const old=harness({supported:false});await old.service.initialize();await old.service.selectLanguage('he');
  assert.equal(old.auth.calls.length,0);assert.equal([...old.values.values()][0],'he');
});
test('English fallback, named substitutions and plural counts preserve user data',()=>{
  messages.setUiLocale('en');
  assert.equal(messages.uiText('language.label'),'Language');
  assert.equal(messages.uiText('a user-authored title'),'a user-authored title');
  assert.equal(messages.uiText('sync.synced',{time:'2:59 pm'}),'Synced 2:59 pm');
  assert.equal(messages.uiPlural('sync.waiting',1),'1 change waiting');
  assert.equal(messages.uiPlural('sync.waiting',3),'3 changes waiting');
  assert.equal(messages.uiWeekdays().length,7);
});
test('empty translated values are omitted so ngx-translate can use its English fallback',async()=>{
  const h=harness();const result=await rx.firstValueFrom(new h.exports.BundledTranslationLoader({}).getTranslation('he'));
  assert.equal(result['language.label'],'שפה');assert.equal('language.system' in result,false);
});
