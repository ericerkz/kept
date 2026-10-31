const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadNoteImages } = require('../test-support/note-images.cjs');
const { createStore } = require('../test-support/workspace-store.cjs');

// EXIF contains an embedded JPEG thumbnail. Its FF D9 must not be mistaken
// for the end of the full-resolution photo, including progressive scan markers.
const jpeg = Buffer.from([0xff,0xd8, 0xff,0xe1,0,8, 0xff,0xd8,0xff,0xd9,0,0,
  0xff,0xda,0,2, 10,0xff,0,20,0xff,0xd0,30, 0xff,0xc4,0,2,
  0xff,0xda,0,2,40,0xff,0xd9]);
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
const heic = Buffer.from('000000186674797068656963000000006d69663168656963','hex');

test('motion photos keep the complete primary JPEG and omit the appended movie', async () => {
  const images = loadNoteImages();
  const motion = new Blob([jpeg, Buffer.from('000000186674797069736f6d','hex')], { type: 'image/jpeg' });
  const prepared = await images.prepareNoteImage(motion, 'Motion photo.jpg');
  assert.deepEqual(Buffer.from(await prepared.blob.arrayBuffer()), jpeg);
  assert.equal(prepared.blob.type, 'image/jpeg');
  assert.equal(prepared.changed, true);
  const retry = await images.prepareNoteImage(motion, 'Motion photo.jpg', { keepJpegBytes: true });
  assert.equal(retry.blob, motion, 'an already-supported queued upload retains its replay hash');
  assert.equal(await images.prepareNoteImage(new Blob([jpeg], {type:'image/jpeg'}), 'Still.jpg').then(item => item.changed), false);
});

test('provider MIME aliases and missing MIME types are corrected without weakening image types', async () => {
  const images = loadNoteImages();
  for (const type of ['', 'application/octet-stream', 'image/jpg']) {
    const result = await images.prepareNoteImage(new Blob([jpeg], { type }), 'photo.jpg');
    assert.equal(result.blob.type, 'image/jpeg');
  }
  const result = await images.prepareNoteImage(new Blob([png], {type:'application/octet-stream'}), 'shared-image');
  assert.equal(result.blob.type, 'image/png');
  assert.equal(images.isNoteImageFile({mimeType:'application/octet-stream',name:'IMG_100.HEIC'}), true);
  for (const type of ['image/gif','image/webp']) {
    const original = new Blob(['animation'], {type});
    assert.equal((await images.prepareNoteImage(original, 'animation')).blob, original, 'ordinary animations are not flattened');
  }
  await assert.rejects(images.prepareNoteImage(new Blob(['<svg onload="alert(1)"/>'], {type:'image/svg+xml'}), 'image.svg'), /Choose a/);
  await assert.rejects(images.prepareNoteImage(new Blob(['video'], {type:'video/quicktime'}), 'clip.mov'), /Choose a/);
});

test('HEIC, including mislabeled Apple image data, becomes JPEG before it can be queued', async () => {
  let closed = 0, encoded = 0;
  const images = loadNoteImages({
    createImageBitmap: async blob => {
      assert.equal(blob.type, 'image/heic');
      return { width: 6000, height: 4000, close: () => closed++ };
    },
    document: { createElement: () => ({ getContext: () => ({fillRect(){},drawImage(){}}),
      toBlob(callback, type) { encoded++; assert.equal(type, 'image/jpeg'); callback(new Blob([jpeg], {type})); } }) }
  });
  for (const type of ['image/heic', 'image/heif', 'image/jpeg']) {
    const result = await images.prepareNoteImage(new Blob([heic], {type}), 'IMG_0001.HEIC');
    assert.equal(result.name, 'IMG_0001.jpg');
    assert.equal(result.blob.type, 'image/jpeg');
  }
  assert.equal(closed, 3); assert.equal(encoded, 3);
  assert.equal(images.MAX_FILE_BYTES, 100 * 1024 * 1024);
  await assert.rejects(images.prepareNoteImage({size:images.MAX_FILE_BYTES+1}, 'too-big.jpg'), /100 MiB/);
  // A failed file must not poison the next conversion in a multi-photo share.
  assert.equal((await images.prepareNoteImage(new Blob([jpeg], {type:'image/jpeg'}), 'next.jpg')).blob.type, 'image/jpeg');
});

test('a repaired queued photo retains its bytes and operation identity across retries', async () => {
  const store = createStore(), workspace = await store.ensureServerWorkspace('photo-owner');
  const url = '/__kept_local_media/photo';
  await store.commitMutation(workspace, 'image.upload', 'old-image-operation', {url,filename:'photo.heic'}, {
    blobs: [{key:`media:${url}`,value:new Blob([heic], {type:'image/heic'})}]
  });
  const [old] = await store.listOutbox(workspace.partition);
  const repaired = await store.prepareQueuedImage(workspace, old, new Blob([jpeg], {type:'image/jpeg'}), 'photo.jpg');
  assert.notEqual(repaired.operationId, old.operationId, 'converted bytes must not reuse a previously accepted upload identity');
  const [retry] = await store.listOutbox(workspace.partition);
  assert.equal(retry.operationId, repaired.operationId);
  assert.equal(retry.payload.filename, 'photo.jpg');
  assert.equal((await store.getBlob(workspace.partition, `media:${url}`)).type, 'image/jpeg');
  await store.acknowledgeImage(workspace, retry, '/api/uploads/images/photo.jpg');
  assert.equal((await store.listOutbox(workspace.partition)).length, 0);
});

test('the HEIC worker selects the primary image and releases decoder memory', async () => {
  const pixels = new Uint8ClampedArray(8), freed = [], messages = [];
  const image = (primary, width) => ({is_primary:()=>primary,get_width:()=>width,get_height:()=>1,
    display(value, callback){callback({...value,data:pixels});},free(){freed.push(width);}});
  const self = { postMessage:value=>messages.push(value) };
  const source = fs.readFileSync('src/assets/photo-heic-worker.js','utf8').replace(/^import .*;$/m, '');
  vm.runInNewContext(source, {self, Uint8Array, Promise, Error,
    ImageData:class {constructor(width,height){this.width=width;this.height=height;this.data=new Uint8ClampedArray(width*height*4);}},
    buildLibheif:()=>({HeifDecoder:class {decoder=1;decode(){return[image(false,1),image(true,2)];}},heif_context_free(){freed.push('context');}})
  });
  await self.onmessage({data:new ArrayBuffer(24)});
  assert.equal(messages[0].width, 2);
  assert.deepEqual(freed, [1,2,'context']);
});
