import { MAX_STORED_PREVIEW_IMAGE_CHARS } from './note-crypto';

// A small copy of a link preview's image as a data: URL, kept inside an
// encrypted note so its preview shows again without any request. Null if the
// image can't be read here or stays too large.
export async function previewThumbnailDataUrl(source: string, maxSize = 480): Promise<string | null> {
  const image = new Image();
  image.src = source;
  await image.decode();
  for (const size of [maxSize, Math.round(maxSize / 2)]) {
    const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/webp', 0.72);
    // Browsers that can't encode WebP return PNG, usually much larger: use
    // JPEG on white instead (it has no transparency).
    if (!dataUrl.startsWith('data:image/webp')) {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.75);
    }
    if (dataUrl.length <= MAX_STORED_PREVIEW_IMAGE_CHARS) return dataUrl;
  }
  return null;
}
