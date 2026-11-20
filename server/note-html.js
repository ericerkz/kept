const sanitizeHtml = require('sanitize-html');
const policy = require('../shared/note-html-policy.json');
const codeLanguages = new Set(['auto', ...require('../shared/code-languages.json').map(language => language.id)]);
const patternIds = new Set(require('../shared/note-appearance.json').patterns.map(pattern => pattern.id));
const { plainText } = require('./text-utils');
const { withoutTakeoutSourceFields } = require('./takeout-metadata');

function safeUrl(value, image = false) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
  if (image && raw.startsWith('blob:')) return raw;
  try {
    const parsed = new URL(raw, 'https://kept.invalid/');
    const schemes = image ? ['http', 'https'] : policy.linkSchemes;
    return schemes.includes(parsed.protocol.slice(0, -1)) ? raw : '';
  } catch { return ''; }
}

const options = {
  nestingLimit: 100,
  allowedTags: policy.tags,
  allowedAttributes: { '*': policy.attributes, pre: policy.codeAttributes },
  allowedSchemes: policy.linkSchemes,
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'blob'] },
  allowedStyles: { '*': Object.fromEntries(Object.entries(policy.styles).map(([key, pattern]) => [key, [new RegExp(pattern, 'i')]])) },
  transformTags: {
    pre: (_tag, attrs) => {
      const clean = { ...attrs };
      if (!codeLanguages.has(clean['data-code-language'])) delete clean['data-code-language'];
      if (!['auto', 'user'].includes(clean['data-code-source'])) delete clean['data-code-source'];
      return { tagName: 'pre', attribs: clean };
    },
    a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, href: safeUrl(attrs.href), rel: 'noopener noreferrer' } }),
    img: (_tag, attrs) => ({ tagName: 'img', attribs: { ...attrs, src: safeUrl(attrs.src, true) } })
  },
  exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src
};

function sanitizeNoteHtml(value) {
  try { return sanitizeHtml(String(value ?? ''), options); }
  catch (error) {
    // Historical/imported content must not disable an entire library's reads.
    // Fail closed to literal text if a parser encounters pathological nesting.
    if (!(error instanceof RangeError)) throw error;
    return plainText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function sanitizeNoteContent(note) {
  note = note && typeof note === 'object' ? note : {};
  return {
    ...withoutTakeoutSourceFields(note),
    ...(Object.hasOwn(note, 'pattern') ? { pattern: patternIds.has(note.pattern)
      && ['', 'none', 'url()', 'url("")', "url('')"].includes(String(note.bgImage || '').trim()) ? note.pattern : null } : {}),
    noteTitle: sanitizeNoteHtml(note.noteTitle),
    noteBody: sanitizeNoteHtml(note.noteBody),
    checkBoxes: (Array.isArray(note.checkBoxes) ? note.checkBoxes : []).filter(item => item && typeof item === 'object')
      .map(item => ({ ...item, data: sanitizeNoteHtml(item.data) })),
    images: (Array.isArray(note.images) ? note.images : []).filter(image => image && typeof image === 'object')
      .map(image => ({ ...image, dataUrl: safeUrl(image.dataUrl, true) }))
  };
}

module.exports = { sanitizeNoteHtml, sanitizeNoteContent, safeUrl };
