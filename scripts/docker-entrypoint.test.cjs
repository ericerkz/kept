const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const run = promisify(execFile);
const image = process.env.KEPT_TEST_DOCKER_IMAGE || 'ghcr.io/ericerkz/kept:latest';
let available = false;
try { execFileSync('docker', ['image', 'inspect', image], {stdio:'ignore'}); available = true; } catch {}
const options = {skip: available ? false : `Requires Docker and a local ${image} image`, timeout:60_000};
// The Dockerfile chmods the script. Invoke it through sh when testing a source
// checkout whose file mode may be non-executable.
const entrypoint = `type=bind,src=${path.resolve('docker-entrypoint.sh')},dst=/usr/local/bin/docker-entrypoint.sh,readonly`;
async function docker(args) {
  return (await run('docker', args, {timeout:40_000,maxBuffer:2*1024*1024})).stdout.trim();
}
async function withVolume(callback) {
  const volume = `kept-entrypoint-test-${randomUUID()}`;
  await docker(['volume','create',volume]);
  try { return await callback(volume); }
  finally { await docker(['volume','rm','-f',volume]); }
}
async function prepare(volume, uid, gid, mode='770') {
  // Keep the volume non-empty: Docker otherwise re-copies the image directory's
  // root ownership when mounting an empty named volume in the next container.
  await docker(['run','--rm','--user','0:0','--entrypoint','sh','-v',`${volume}:/app/data`,image,
    '-c','touch /app/data/.test-volume && chown "$1:$2" /app/data && chmod "$3" /app/data','sh',String(uid),String(gid),mode]);
}
const probe = `const fs=require('node:fs');
fs.writeFileSync('/app/data/probe','writable');
const stat=fs.statSync('/app/data');
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),owner:stat.uid,group:stat.gid}));`;
async function identity(volume, args=[]) {
  const output=await docker(['run','--rm','--entrypoint','sh','--mount',entrypoint,'-v',`${volume}:/app/data`,...args,image,'/usr/local/bin/docker-entrypoint.sh','node','-e',probe]);
  return JSON.parse(output.split('\n').at(-1));
}

test('default root startup still prepares data and drops to 1000:1000',options,()=>withVolume(async volume=>{
  const result=await identity(volume);
  assert.deepEqual([result.uid,result.gid,result.owner,result.group],[1000,1000,1000,1000]);
}));

test('root startup still honours custom PUID/PGID and creates an arbitrary runtime user',options,()=>withVolume(async volume=>{
  const result=await identity(volume,['-e','PUID=12345','-e','PGID=23456']);
  assert.deepEqual([result.uid,result.gid,result.owner,result.group],[12345,23456,12345,23456]);
}));

test('explicit non-root startup works without user-switching capabilities',options,()=>withVolume(async volume=>{
  await prepare(volume,1000,1000);
  const result=await identity(volume,['--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges']);
  assert.deepEqual([result.uid,result.gid],[1000,1000]);
}));

test('explicit identity overrides different PUID/PGID defaults without changing ownership',options,()=>withVolume(async volume=>{
  await prepare(volume,12345,23456);
  const result=await identity(volume,['--user','12345:23456','--cap-drop','ALL','-e','PUID=1000','-e','PGID=1000']);
  assert.deepEqual([result.uid,result.gid,result.owner,result.group],[12345,23456,12345,23456]);
}));

test('supplementary volume group access is preserved for arbitrary users',options,()=>withVolume(async volume=>{
  await prepare(volume,0,34567);
  const result=await identity(volume,['--user','12345:23456','--group-add','34567','--cap-drop','ALL']);
  assert.equal(result.uid,12345);
  assert.ok(result.groups.includes(34567));
  assert.deepEqual([result.owner,result.group],[0,34567]);
}));

test('unwritable or read-only data stops with an actionable permissions error',options,()=>withVolume(async volume=>{
  await prepare(volume,0,0,'700');
  for(const readonly of [false,true]) {
    if(readonly) await prepare(volume,12345,23456);
    await assert.rejects(docker(['run','--rm','--entrypoint','sh','--mount',entrypoint,'--user','12345:23456','--cap-drop','ALL',
      '-v',`${volume}:/app/data${readonly?':ro':''}`,image,'/usr/local/bin/docker-entrypoint.sh','node','-e',"throw new Error('Application must not start');"]), error=>{
      assert.equal(error.code,1);
      assert.match(error.stderr,/Kept cannot write to \/app\/data as UID 12345 \/ GID 23456/);
      assert.doesNotMatch(error.stderr,/Application must not start|su-exec:/);
      return true;
    });
  }
}));

test('application saves notes and attachments and reloads them after a fully non-root restart',options,()=>withVolume(async volume=>{
  await prepare(volume,12345,23456);
  const name=`kept-entrypoint-test-${randomUUID()}`;
  const ready=`
    const assert=require('node:assert/strict');
    (async()=>{
      for(let attempt=0;attempt<100;attempt++){
        try {if((await fetch('http://127.0.0.1:6767/api/setup/status')).ok)return;}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('Server did not start');
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const api=`
    const assert=require('node:assert/strict');
    (async()=>{
      const base='http://127.0.0.1:6767/api';
      const credentials={username:'container-owner',password:'test-container-password-123'};
      const json={'Content-Type':'application/json'};
      if(!process.env.RESTART_CHECK){
        const setup=await fetch(base+'/setup/admin',{method:'POST',headers:json,body:JSON.stringify(credentials)});
        assert.equal(setup.status,201,await setup.text());
      }
      const login=await fetch(base+'/auth/login',{method:'POST',headers:json,body:JSON.stringify(credentials)});
      assert.equal(login.status,200);
      const session=await login.json();
      const headers={...json,Authorization:'Bearer '+session.token};
      if(!process.env.RESTART_CHECK){
        const response=await fetch(base+'/notes',{method:'POST',headers,body:JSON.stringify({noteTitle:'Non-root persistence',noteBody:'Saved without root'})});
        assert.equal(response.status,201,await response.clone().text());
        const note=await response.json();
        const form=new FormData();form.append('file',new Blob(['attachment survives restart'],{type:'text/plain'}),'persistence.txt');
        const upload=await fetch(base+'/notes/'+note.id+'/attachments',{method:'POST',headers:{Authorization:headers.Authorization},body:form});
        assert.equal(upload.status,201,await upload.text());
      }
      const notes=await (await fetch(base+'/notes',{headers})).json();
      const note=notes.find(note=>note.noteTitle==='Non-root persistence');assert.ok(note);
      const full=await (await fetch(base+'/notes/'+note.id,{headers})).json();
      assert.equal(full.noteBody,'Saved without root');assert.equal(full.attachments.length,1);
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  try {
    await docker(['run','-d','--name',name,'--entrypoint','sh','--mount',entrypoint,'-v',`${volume}:/app/data`,
      '--user','12345:23456','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--tmpfs','/tmp',image,'/usr/local/bin/docker-entrypoint.sh','node','server/server.js']);
    await docker(['exec',name,'node','-e',ready]);
    await docker(['exec',name,'node','-e',api]);
    await docker(['restart',name]);
    await docker(['exec',name,'node','-e',ready]);
    await docker(['exec','-e','RESTART_CHECK=1',name,'node','-e',api]);
  } finally { await docker(['rm','-f',name]); }
}));
