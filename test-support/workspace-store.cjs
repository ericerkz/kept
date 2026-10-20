const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
function createStore(database = new IDBFactory()) {
  const cache = new Map();
  const values = new Map();
  const localStorage = {getItem:key=>values.get(key) || null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  const window = Object.assign(new EventTarget(),{location:{origin:'https://kept.test'}});
  const globals = {console,indexedDB:database,IDBKeyRange,localStorage,window,navigator:{onLine:true},crypto:globalThis.crypto,
    Blob,URL,Date,Promise,Map,Set,TypeError,Error,Uint8Array,setTimeout,clearTimeout};
  function load(filename) {
    filename=path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const exports={};cache.set(filename,exports);
    const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
    vm.runInNewContext(compiled,{...globals,exports,require(name){
      if (name === '@angular/core') return {Injectable:()=>target=>target};
      if (name === '@capacitor/core') return {Capacitor:{isNativePlatform:()=>false}};
      if (name.endsWith('/environment')) return {environment:{apiUrl:'/api'}};
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename),name+'.ts'));
      throw new Error(`Unexpected store dependency: ${name}`);
    }},{filename});
    return exports;
  }
  const {OfflineStoreService}=load(path.join(__dirname,'../src/app/services/offline-store.service.ts'));
  return new OfflineStoreService();
}
module.exports={createStore};
