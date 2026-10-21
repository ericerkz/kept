const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),rx=require('rxjs');
const source=ts.transpileModule(fs.readFileSync('src/app/services/auth.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
function harness({native=true,available=true,local=false,httpError,forgetError}={}) {
 const events=[],values=new Map([['gk_session','session'],['kept_active_workspace', 'retained-library-reference']]);
 const localStorage={getItem:key=>values.get(key)||null,removeItem:key=>{events.push(`remove:${key}`);values.delete(key);}};
 const window={KEPT_API_URL:'https://server.test',location:{replace:path=>events.push(`replace:${path}`)}};
 const plugin={forgetServer:async()=>{
  events.push('forget');assert.equal(values.has('gk_session'),false);assert.equal(auth.currentUser,null);
  if(forgetError)throw forgetError;delete window.KEPT_API_URL;
 }};
 const exports={};
 class HttpErrorResponse extends Error{constructor(status){super(`HTTP ${status}`);this.status=status;}}
 class HttpHeaders{constructor(headers){this.headers=headers;}}
 vm.runInNewContext(source,{exports,console,localStorage,window,require(name){
  if(name==='@angular/core')return{Injectable:()=>target=>target};
  if(name==='@angular/common/http')return{HttpHeaders,HttpErrorResponse};
  if(name==='@capacitor/core')return{Capacitor:{isNativePlatform:()=>native,isPluginAvailable:()=>available},registerPlugin:name=>{assert.equal(name,'KeptWorkspace');return plugin;}};
  if(name==='rxjs')return rx;
  if(name.endsWith('/environment'))return{environment:{apiUrl:'/api'}};
  if(name.endsWith('/note-html'))return{};
  throw Error(`Unexpected auth dependency: ${name}`);
 }});
 const auth=Object.create(exports.AuthService.prototype);
 Object.assign(auth,{sessionKey:'gk_session',apiUrl:'/api',usesBrowserSession:!native,currentUser$:new rx.BehaviorSubject({id:1,token:'token'}),workspace:{isLocal:local,selectServer:async()=>events.push('leave-local')},http:{post:()=>{events.push('server-logout');return httpError?rx.throwError(()=>new HttpErrorResponse(httpError)):rx.of({});}}});
 return{auth,events,values,window};
}
test('native sign-out clears the session, forgets the server, then reloads root; local libraries stay intact',async()=>{
 const h=harness();assert.equal(await h.auth.logout(),true);
 assert.deepEqual(h.events,['server-logout','remove:gk_session','forget','replace:/']);
 assert.equal(h.values.get('kept_active_workspace'),'retained-library-reference');
 assert.equal(h.window.KEPT_API_URL,undefined);
});
test('web and older native clients retain the login-route fallback',async()=>{
 for(const options of [{native:false},{available:false},{forgetError:{code:'UNIMPLEMENTED'}}]){
  const h=harness(options);assert.equal(await h.auth.logout(),false);
  assert.equal(h.auth.currentUser,null);assert.equal(h.events.some(event=>event.startsWith('replace:')),false);
  if(options.native===false||options.available===false)assert.equal(h.events.includes('forget'),false);
 }
});
test('offline native sign-out still forgets its server; web logout failure preserves the session',async()=>{
 const native=harness({httpError:503});assert.equal(await native.auth.logout(),true);assert.equal(native.events.at(-1),'replace:/');
 const web=harness({native:false,httpError:503});await assert.rejects(web.auth.logout());assert.ok(web.auth.currentUser);assert.equal(web.values.has('gk_session'),true);
});
test('native reset failure does not navigate and can be retried after the session is cleared',async()=>{
 const h=harness({forgetError:new Error('Native write failed')});
 await assert.rejects(h.auth.logout(),error=>error.name==='KeptServerResetError');
 assert.equal(h.auth.currentUser,null);assert.equal(h.events.some(event=>event.startsWith('replace:')),false);
 await assert.rejects(h.auth.logout(),error=>error.name==='KeptServerResetError');
 assert.equal(h.events.filter(event=>event==='forget').length,2);
});
test('leaving local mode does not forget server configuration',async()=>{
 const h=harness({local:true});assert.equal(await h.auth.logout(),false);assert.deepEqual(h.events,['leave-local']);
});
