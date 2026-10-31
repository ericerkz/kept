// A same-origin module worker keeps decoding off the UI thread without blob
// scripts or unsafe-eval. The decoder is copied from the pinned dependency.
import buildLibheif from './vendor/heic-to/libheif-without-unsafe-eval.js';

self.onmessage = async ({ data: buffer }) => {
  let libheif, decoder, images;
  try {
    libheif = await buildLibheif();
    decoder = new libheif.HeifDecoder();
    images = decoder.decode(new Uint8Array(buffer));
    const image = images.find(item => item.is_primary()) || images[0];
    if (!image) throw new Error('The photo has no readable still image.');
    const width = image.get_width(), height = image.get_height();
    if (!width || !height || width * height > 64 * 1024 * 1024) throw new Error('This photo has too many pixels to process safely.');
    const pixels = new ImageData(width, height);
    const result = await new Promise((resolve, reject) => image.display(pixels, value => value ? resolve(value) : reject(new Error('Could not decode this photo.'))));
    self.postMessage({ width, height, data: result.data }, [result.data.buffer]);
  } catch (error) { self.postMessage({ error: error?.message || 'Could not decode this HEIC photo.' }); }
  finally {
    for (const image of images || []) image.free();
    if (decoder?.decoder) libheif.heif_context_free(decoder.decoder);
  }
};
