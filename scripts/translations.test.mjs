import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {check,inspectCatalogue,inspectReuse,readJson,readCatalogue,readReuse,messagesFor,sections} from './translations.mjs';
test('all shipped source catalogues validate and template keys exist',()=>{
  assert.deepEqual(check().errors,[]);
  const source=messagesFor(readCatalogue('en'), 'shared');
  const englishValues=new Set(Object.values(source));
  for(const file of fs.readdirSync('src/app',{recursive:true}).filter(file=>/\.(html|ts)$/.test(file)&&!file.endsWith('.spec.ts'))) {
    const text=fs.readFileSync(`src/app/${file}`,'utf8');
    for(const match of text.matchAll(/'([a-z][a-z0-9_.]+)'\s*\|\s*translate\b|uiText\('([a-z][a-z0-9_.]+)'/g)) {
      assert.ok(Object.hasOwn(source,match[1]||match[2]),`${file}: ${match[1]||match[2]}`);
    }
    if(file.endsWith('.html'))for(const match of text.matchAll(/'((?:\\.|[^'\\])*)'\s*\|\s*uiText\b/g)) {
      const value=match[1].replace(/\\'/g,"'");
      assert.ok(Object.hasOwn(source,value)||englishValues.has(value),`${file}: uncatalogued UI message ${value}`);
    }
    if(file.endsWith('.ts')) {
      const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
      function visit(node) {
        if(ts.isCallExpression(node)&&['uiText','uiPlural'].includes(node.expression.getText(ast))) {
          const argument=node.arguments[0];
          if(argument&&(ts.isStringLiteral(argument)||ts.isNoSubstitutionTemplateLiteral(argument))) {
            if(node.expression.getText(ast)==='uiPlural') {
              assert.ok(Object.hasOwn(source,`${argument.text}.other`),`${file}: uncatalogued plural message ${argument.text}`);
            } else {
              assert.ok(Object.hasOwn(source,argument.text)||englishValues.has(argument.text),`${file}: uncatalogued UI message ${argument.text}`);
            }
          }
        }
        if(ts.isPropertyDeclaration(node)&&node.name.getText(ast)==='bgImageLabels') {
          assert.ok(node.initializer&&ts.isObjectLiteralExpression(node.initializer),`${file}: background labels need explicit message IDs`);
          for(const property of node.initializer.properties) {
            assert.ok(ts.isPropertyAssignment(property)&&ts.isStringLiteral(property.initializer),`${file}: background label needs a message ID`);
            assert.ok(Object.hasOwn(source,property.initializer.text),`${file}: uncatalogued background label ${property.initializer.text}`);
          }
        }
        ts.forEachChild(node,visit);
      }
      visit(ast);
    }
  }
});
test('malformed catalogues, markup, missing plural variants and changed placeholders are rejected',()=>{
  const source={'message':'Hello {{name}}','items.one':'{{count}} item','items.other':'{{count}} items'};
  assert.ok(inspectCatalogue(source,{message:'<script>bad</script>'},'en',true).errors.length>=2);
  assert.ok(inspectCatalogue(source,{message:'Hello {{someone}}'},'en').errors.length);
  assert.ok(inspectCatalogue(source,{unknown:'Hi'},'en').errors.length);
  const result=inspectCatalogue(source,source,'ar',true);
  assert.ok(result.missing.includes('items.few'));assert.ok(result.errors.length);
  assert.deepEqual(inspectCatalogue(source,{...source,message:''},'en').errors,[]);
});

test('explicit reuse preserves app IDs and context without merging unrelated English matches',()=>{
  const source={shared:{'common.save':'Save','welcome.person':'Hello {{name}}'},android:{'dialog.save':'Save'},ios:{}};
  const reuse={android:{'legacy.save':'shared/common.save'},ios:{'common.save':'shared/common.save','profile.greeting':'shared/welcome.person'}};
  assert.deepEqual(inspectReuse(source,reuse),[]);
  const partial={shared:{'common.save':'Enregistrer','welcome.person':'Bonjour {{name}}'},android:{'dialog.save':'Sauvegarder'}};
  assert.deepEqual(messagesFor(partial,'android',reuse),{'dialog.save':'Sauvegarder','legacy.save':'Enregistrer'});
  assert.deepEqual(messagesFor(partial,'ios',reuse),{'common.save':'Enregistrer','profile.greeting':'Bonjour {{name}}'});
  assert.deepEqual(messagesFor({},'ios',reuse),{},'absent translations leave English fallback to the exporter');
  assert.ok(inspectReuse(source,{ios:{'legacy.save':'shared/missing'}}).length);
  assert.ok(inspectReuse(source,{ios:{'legacy.save':'android/legacy.save'},android:{'legacy.save':'ios/legacy.save'}}).length,'alias chains and cycles are rejected');
  assert.ok(inspectReuse(source,{android:{'dialog.save':'shared/common.save'}}).length,'canonical text cannot also be an alias');
  assert.ok(inspectReuse(source,{ios:{'constructor':'shared/common.save'}}).length);
  assert.ok(inspectReuse(source,{other:{}}).length);
  assert.ok(inspectReuse(source,{ios:[]}).length);
  assert.ok(inspectReuse(source,{ios:{save:{}}}).length);
  assert.ok(inspectCatalogue(source.shared,{'welcome.person':'Bonjour {{other}}'},'fr').errors.length,'canonical placeholders remain validated');
});

test('reused native keys retain their source context, including both legacy iOS widget keys',()=>{
  const source=readCatalogue('en'),reuse=readReuse(),context=readJson('translations/context.json');
  assert.deepEqual(inspectReuse(source,reuse),[]);
  for(const scope of sections) {
    const exported=messagesFor(source,scope,reuse);
    for(const [key,target] of Object.entries(reuse[scope]||{})) {
      const [targetScope,targetKey]=target.split('/');
      assert.equal(Object.hasOwn(source[scope],key),false,`${scope}/${key} should only be translated at ${target}`);
      assert.equal(exported[key],source[targetScope][targetKey]);
      assert.ok(context[scope][key]?.length,`${scope}/${key} retains its app's context for native generators`);
    }
  }
  const ios=messagesFor(source,'ios',reuse);
  assert.equal(ios['keptsirischemas.untitled_note'],'Untitled note');
  assert.equal(ios['keptsirishortcuts.note'],'Note');
});

test('source code is rejected even when it was accidentally extracted into the English reference',()=>{
  for(const value of [
    "(function() { try { const tokenCandidates = []; return tokenCandidates; } catch (e) { return ''; } })();",
    ').ifBlank {',
    '},\n confidence = confidence,\n warnings = listOf(',
    ')\n .ifEmpty { firstAction.optString(',
    ', raw.optString(',
    'val body = firstAction.optString(',
    'private fun copyString(from: JSONObject) {',
    "localStorage.getItem('gk_session')"
  ]) {
    const result=inspectCatalogue({'message':value},{'message':value},'en');
    assert.ok(result.errors.some(error=>error.includes('source code instead of UI text')),value);
  }
  const copy={message:'Hello {{name}}.\n\nUse Settings to change your preferences.', 'items.other':'({{count}}) Completed items', suffix:', then choose your delivery method', parenthesis:'{{name}}) is ready'};
  assert.deepEqual(inspectCatalogue(copy,copy,'en').errors,[]);
  const asset={message:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='};
  assert.ok(inspectCatalogue(asset,asset,'en').errors.some(error=>error.includes('embedded asset data')));
});

test('web messages have production references, with no orphaned entries or extracted identifiers',()=>{
  const source=messagesFor(readCatalogue('en'), 'shared');
  const allContext=readJson('translations/context.json');
  const context=allContext.shared;
  assert.deepEqual(Object.keys(context).sort(),Object.keys(source).sort());
  const files=fs.readdirSync('src/app',{recursive:true})
    .filter(file=>/\.(html|ts)$/.test(file)&&!/(?:\.test|\.spec)\.ts$/.test(file)).map(file=>`src/app/${file}`);
  const texts=new Map(files.map(file=>[file,fs.readFileSync(file,'utf8')]));
  const literals=new Map();
  for(const [file,text] of texts)if(file.endsWith('.ts')) {
    const values=new Set(),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    function visit(node) {
      if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))values.add(node.text);
      ts.forEachChild(node,visit);
    }
    visit(ast);literals.set(file,values);
  }
  for(const [key,value] of Object.entries(source)) {
    const base=key.replace(/\.(one|other)$/,'');
    const explicit=file=>[key,base].some(name=>texts.get(file)?.includes(`'${name}'`)||texts.get(file)?.includes(`"${name}"`));
    assert.ok(context[key].length,`${key} needs a source reference`);
    for(const file of context[key])assert.ok(texts.has(file)&&(explicit(file)||literals.get(file)?.has(value)),`${key}: stale reference ${file}`);
    if(!files.some(explicit)) {
      assert.ok(!(/^[\S]+$/.test(value)&&/[a-z][A-Z]/.test(value)),`${key}: internal identifier needs an actual UI binding`);
      assert.ok(!key.startsWith('demo_notes.'),`${key}: stored demo content has no translation lookup`);
    }
  }
});

test('native catalogues and translator context contain matching UI-only entries',()=>{
  const context=readJson('translations/context.json');
  const catalogue=readCatalogue('en');
  for(const platform of ['android','ios']) {
    const source=messagesFor(catalogue,platform);
    assert.deepEqual(Object.keys(context[platform]).sort(),Object.keys(source).sort());
    for(const [key,value] of Object.entries(source)) {
      assert.ok(context[platform][key].length,`${platform}/${key} needs a source reference`);
      for(const reference of context[platform][key]) {
        assert.match(reference,/\.(?:kt|swift):[1-9]\d*$|\.xml#[\w_]+$/,`${platform}/${key}`);
        assert.ok(!reference.startsWith('/')&&!reference.includes('..'),`${platform}/${key}: use repository-relative references`);
      }
      assert.doesNotMatch(value,/^(?:\[KeptShare\]|(?:\{\{\w+\}\})?\/account$)/,key);
      assert.doesNotMatch(value,/^(?:KeptGeminiNano|KeptOnboarding|ServerSignInDialog|SmartCaptureSearch|WidgetTokenSync|WidgetCameraCapture|KeptWidget\w+|KeptSingleNoteWidget\w+|KeptSmartCapturePlugin)$/,key);
    }
  }
});

test('one partial catalogue produces separate app bundles with independent labels and English fallback',async()=>{
  const {mkdtemp,cp,mkdir,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const path=await import('node:path');
  const {execFileSync,spawnSync,spawn}=await import('node:child_process');
  const directory=await mkdtemp(path.join(tmpdir(),'kept-i18n-'));
  try {
    for(const relative of ['scripts','translations'])await mkdir(path.join(directory,relative),{recursive:true});
    await cp('scripts/translations.mjs',path.join(directory,'scripts/translations.mjs'));
    for(const relative of ['translations/en.json','translations/languages.json','translations/reuse.json'])await cp(relative,path.join(directory,relative));
    const run=(...args)=>execFileSync(process.execPath,[path.join(directory,'scripts/translations.mjs'),...args],{cwd:directory,stdio:'pipe'});
    const englishFile=path.join(directory,'translations/en.json');
    const reuseFile=path.join(directory,'translations/reuse.json');
    const originalReuse=fs.readFileSync(reuseFile,'utf8');
    const original=fs.readFileSync(englishFile,'utf8');
    for(const malformed of [
      '{"shared":{"common.save":"Save","common.save":"Save"},"android":{},"ios":{}}',
      '{"shared":{"common.save":"Save","common.\\u0073ave":"Save"},"android":{},"ios":{}}'
    ]) {
      fs.writeFileSync(englishFile,malformed);
      assert.throws(()=>run('check'),/Duplicate key/);
    }
    fs.writeFileSync(englishFile,JSON.stringify({shared:{message:'Shared wording'},android:{message:'Android wording'},ios:{message:'iOS wording'}}));
    fs.writeFileSync(reuseFile,'{}');
    run('check'); // Identical keys in separate sections are independent messages.
    for(const invalid of [{shared:[],android:{},ios:{}},{shared:{},android:{},ios:{},other:{}}]) {
      fs.writeFileSync(englishFile,JSON.stringify(invalid));assert.throws(()=>run('check'));
    }
    fs.writeFileSync(englishFile,original);
    fs.writeFileSync(reuseFile,originalReuse);
    run('init','he','--name','Hebrew','--native-name','עברית','--rtl');
    const localeFile=path.join(directory,'translations/he.json');
    assert.deepEqual(Object.keys(JSON.parse(await readFile(localeFile,'utf8'))),sections);
    run('check');assert.throws(()=>run('check','--complete','he'));
    const exported=path.join(directory,'export');run('export-native','android','--out',exported);
    assert.deepEqual(JSON.parse(await readFile(path.join(exported,'he.json'),'utf8')),messagesFor(readCatalogue('en'),'android'),
      'a new partial language is exported immediately with English fallback');
    assert.ok(fs.existsSync(path.join(exported,'en.json')));
    assert.throws(()=>run('init','he'),'existing work must not be overwritten');
    const partial=JSON.parse(await readFile(localeFile,'utf8'));
    partial.shared['common.save']='<script>bad</script>';
    fs.writeFileSync(localeFile,JSON.stringify(partial));
    assert.throws(()=>run('check'),'partial translations must still reject unsafe messages');
    assert.throws(()=>run('export-native','ios','--out',exported),'unsafe messages must not reach app bundles');
    partial.shared['common.save']='שמירה';
    const english=JSON.parse(original);
    const androidKey=Object.keys(partial.android).find(key=>!key.startsWith('common.')&&!english.android[key].includes('{{'));partial.android[androidKey]='Android-only translation';
    const iosKey=Object.keys(partial.ios).find(key=>!key.startsWith('common.')&&!english.ios[key].includes('{{'));partial.ios[iosKey]='iOS-only translation';
    const sharedKey='language.label';partial.shared[sharedKey]='שפה';
    fs.writeFileSync(localeFile,JSON.stringify(partial));
    const manifest=JSON.parse(await readFile(path.join(directory,'translations/languages.json'),'utf8'));
    const addedLanguage=manifest.languages.find(language=>language.code==='he');
    assert.deepEqual(addedLanguage,{code:'he',name:'Hebrew',nativeName:'עברית',direction:'rtl'});
    const checked=spawnSync(process.execPath,[path.join(directory,'scripts/translations.mjs'),'check'],{cwd:directory,encoding:'utf8'});
    assert.equal(checked.status,0);assert.match(checked.stderr,/untranslated messages; English fallback applies/);
    assert.throws(()=>run('check','--complete','he'),'strict completeness remains an optional check');
    for(const platform of ['shared','android','ios']) {
      const output=path.join(directory,`export-${platform}`);
      if(platform==='shared')run('export-web','--out',output);else run('export-native',platform,'--out',output);
      const bundle=JSON.parse(await readFile(path.join(output,'he.json'),'utf8'));
      const expected={...messagesFor(readCatalogue('en'),platform),...Object.fromEntries(Object.entries(messagesFor(partial,platform)).filter(([,value])=>value.trim()))};
      assert.deepEqual(bundle,expected);
      assert.equal(bundle['common.save'],'שמירה','one shared translation reaches all three interfaces');
      if(platform!=='shared')assert.equal(sharedKey in bundle,false,'native exports exclude shared UI copy');
      if(platform!=='android')assert.equal(androidKey in bundle,false,'other apps exclude Android-only copy');
      if(platform!=='ios')assert.equal(iosKey in bundle,false,'other apps exclude iOS-only copy');
      const languages=JSON.parse(await readFile(path.join(output,'languages.json'),'utf8'));
      assert.ok(languages.languages.some(language=>language.code==='he'));
      manifest.languages=manifest.languages.filter(language=>language.code!=='he');
      fs.writeFileSync(path.join(directory,'translations/languages.json'),JSON.stringify(manifest));
      if(platform==='shared')run('export-web','--out',output);else run('export-native',platform,'--out',output);
      assert.equal(fs.existsSync(path.join(output,'he.json')),false,'withdrawn languages leave no stale generated files');
      manifest.languages.push(addedLanguage);
      fs.writeFileSync(path.join(directory,'translations/languages.json'),JSON.stringify(manifest));
    }
    const watchOutput=path.join(directory,'watch-export');
    const watcher=spawn(process.execPath,[path.join(directory,'scripts/translations.mjs'),'export-web','--out',watchOutput,'--watch'],{cwd:directory,stdio:['ignore','pipe','pipe']});
    const waitFor=async predicate=>{
      const deadline=Date.now()+5000;
      while(!predicate()) {
        assert.ok(Date.now()<deadline,'translation watcher did not update its output');
        await new Promise(resolve=>setTimeout(resolve,30));
      }
    };
    let watchMessages='';
    watcher.stdout.on('data',chunk=>watchMessages+=chunk);
    watcher.stderr.on('data',()=>{});
    try {
      await waitFor(()=>watchMessages.includes('Translation catalogues valid'));
      const changed=JSON.parse(original);changed.shared['common.save']='Save updated';
      fs.writeFileSync(englishFile,JSON.stringify(changed));
      const watchBundle=()=>JSON.parse(fs.readFileSync(path.join(watchOutput,'en.json'),'utf8'));
      await waitFor(()=>watchBundle()['common.save']==='Save updated');
      fs.writeFileSync(englishFile,'{invalid');
      await new Promise(resolve=>setTimeout(resolve,350));
      assert.equal(watchBundle()['common.save'],'Save updated','invalid edits preserve the last valid bundle');
      fs.writeFileSync(englishFile,original);
      await waitFor(()=>watchBundle()['common.save']==='Save');
    } finally {
      const stopped=new Promise(resolve=>watcher.once('exit',resolve));
      watcher.kill();await stopped;
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
