import createDOMPurify from 'dompurify';
import policy from '../../../shared/note-html-policy.json';

// Use a private instance: editor helpers must sanitize BEFORE parsing in the
// live document, including content restored from pre-patch offline caches.
const purifier = createDOMPurify(window);
const styles = Object.entries(policy.styles).map(([name, pattern]) => [name, new RegExp(pattern, 'i')] as const);

export function safeNoteUrl(value: unknown, image = false): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
  if (image && raw.startsWith('blob:')) return raw;
  try {
    const parsed = new URL(raw, 'https://kept.invalid/');
    return (image ? ['http', 'https'] : policy.linkSchemes).includes(parsed.protocol.slice(0, -1)) ? raw : '';
  } catch { return ''; }
}

purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'href' || data.attrName === 'src') {
    data.attrValue = safeNoteUrl(data.attrValue, data.attrName === 'src');
    if (!data.attrValue) data.keepAttr = false;
  }
  if (data.attrName === 'style') {
    const style = document.createElement('span').style;
    style.cssText = data.attrValue;
    data.attrValue = styles.flatMap(([name, pattern]) => {
      const value = style.getPropertyValue(name).trim();
      return value && pattern.test(value) ? [`${name}: ${value}`] : [];
    }).join('; ');
    if (!data.attrValue) data.keepAttr = false;
  }
});
purifier.addHook('afterSanitizeAttributes', node => {
  if (node.nodeName === 'A') node.setAttribute('rel', 'noopener noreferrer');
});

export function sanitizeNoteHtml(value: unknown): string {
  return purifier.sanitize(String(value ?? ''), {
    ALLOWED_TAGS: [...policy.tags, 'button'],
    ALLOWED_ATTR: [...policy.attributes, ...policy.editorAttributes],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_URI_SAFE_ATTR: policy.editorAttributes,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|kept|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    ADD_DATA_URI_TAGS: ['img']
  });
}

// A container with no browsing context cannot start image loads while helpers
// rewrite private image URLs or extract text. Preserve ordinary URL resolution.
const parsingDocument = document.implementation.createHTMLDocument('');
const parsingBase = parsingDocument.createElement('base');
parsingBase.href = document.baseURI;
parsingDocument.head.append(parsingBase);

export function createNoteHtmlContainer(): HTMLDivElement {
  return parsingDocument.createElement('div');
}
