const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createPublicFileDownloader } = require('./public-file-download');

function fixture({ addresses = [{address:'93.184.216.34',family:4}], replies = [{status:200,body:'file'}] } = {}) {
  const calls = [], resolved = [];
  const download = createPublicFileDownloader({
    lookup: async host => { resolved.push(host); return addresses; },
    request(url, options, callback) {
      calls.push({url,options});
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const reply = replies.shift();
        const response = Readable.from(reply.chunks || [Buffer.from(reply.body || '')]);
        response.statusCode = reply.status; response.headers = reply.headers || {};
        options.signal.addEventListener('abort', () => response.destroy(options.signal.reason), {once:true});
        callback(response);
      });
      return req;
    }
  });
  return {download,calls,resolved};
}

test('file downloads pin the checked IP while preserving hostname/TLS and omitting credentials', async () => {
  const h = fixture();
  assert.equal(String(await h.download('https://files.example/a.txt',{maxBytes:100})), 'file');
  assert.deepEqual(h.resolved,['files.example']);
  const {url,options} = h.calls[0];
  assert.equal(url.hostname,'files.example'); assert.equal(options.agent,false);
  assert.equal(options.rejectUnauthorized,undefined, 'default certificate verification stays enabled');
  assert.deepEqual(options.headers,{Accept:'*/*'});
  const answer = await new Promise((resolve,reject) => options.lookup('files.example',{all:true},(error,value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(answer,[{address:'93.184.216.34',family:4}], 'connection must not perform a second DNS lookup');
});

test('private, CGNAT, mapped/translation IPv6, reserved and mixed DNS destinations are blocked', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','198.18.0.1','::1','::ffff:127.0.0.1','64:ff9b::7f00:1','fe90::1','2001:db8::1']) {
    const h = fixture({addresses:[{address,family:address.includes(':')?6:4}]});
    await assert.rejects(h.download('https://files.example/file',{maxBytes:100}),/private or reserved/);
    assert.equal(h.calls.length,0,address);
  }
  const mixed = fixture({addresses:[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]});
  await assert.rejects(mixed.download('https://files.example/file',{maxBytes:100}),/private or reserved/);
  for (const url of ['http://files.example/x','https://user:pass@files.example/x','https://127.0.0.1/x','https://[::1]/x']) {
    const h=fixture(); await assert.rejects(h.download(url,{maxBytes:100})); assert.equal(h.calls.length,0);
  }
});

test('each redirect is revalidated; private redirects and redirect loops are rejected', async () => {
  const h=fixture({replies:[{status:302,headers:{location:'/next'}},{status:200,body:'second'}]});
  assert.equal(String(await h.download('https://files.example/first',{maxBytes:100})),'second');
  assert.equal(h.resolved.length,2);
  const bad=fixture({replies:[{status:302,headers:{location:'https://127.0.0.1/private'}}]});
  await assert.rejects(bad.download('https://files.example/first',{maxBytes:100}),/private or reserved/);assert.equal(bad.calls.length,1);
  const loop=fixture({replies:Array.from({length:4},()=>({status:302,headers:{location:'/again'}}))});
  await assert.rejects(loop.download('https://files.example/first',{maxBytes:100}),/Too many redirects/);
});

test('declared and streamed sizes are bounded and DNS shares the overall deadline', async () => {
  const declared=fixture({replies:[{status:200,headers:{'content-length':'101'}}]});
  await assert.rejects(declared.download('https://files.example/file',{maxBytes:100}),/too large/);
  const streamed=fixture({replies:[{status:200,chunks:[Buffer.alloc(60),Buffer.alloc(60)]}]});
  await assert.rejects(streamed.download('https://files.example/file',{maxBytes:100}),/too large/);
  const download=createPublicFileDownloader({lookup:()=>new Promise(()=>{}),request:()=>assert.fail('must not connect')});
  await assert.rejects(download('https://files.example/file',{maxBytes:100,timeoutMs:20}),/timed out/);
});
