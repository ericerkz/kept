const sanitizeHtml = require('sanitize-html');
const policy = require('../shared/note-html-policy.json');

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
  allowedTags: policy.tags,
  allowedAttributes: { '*': policy.attributes },
  allowedSchemes: policy.linkSchemes,
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'blob'] },
  allowedStyles: { '*': Object.fromEntries(Object.entries(policy.styles).map(([key, pattern]) => [key, [new RegExp(pattern, 'i')]])) },
  transformTags: {
    a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, href: safeUrl(attrs.href), rel: 'noopener noreferrer' } }),
    img: (_tag, attrs) => ({ tagName: 'img', attribs: { ...attrs, src: safeUrl(attrs.src, true) } })
  },
  exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src
};

function sanitizeNoteHtml(value) {
  return sanitizeHtml(String(value ?? ''), options);
}

function sanitizeNoteContent(note) {
  note = note && typeof note === 'object' ? note : {};
  return {
    ...note,
    noteTitle: sanitizeNoteHtml(note.noteTitle),
    noteBody: sanitizeNoteHtml(note.noteBody),
    checkBoxes: (Array.isArray(note.checkBoxes) ? note.checkBoxes : []).filter(item => item && typeof item === 'object')
      .map(item => ({ ...item, data: sanitizeNoteHtml(item.data) })),
    images: (Array.isArray(note.images) ? note.images : []).filter(image => image && typeof image === 'object')
      .map(image => ({ ...image, dataUrl: safeUrl(image.dataUrl, true) }))
  };
}

module.exports = { sanitizeNoteHtml, sanitizeNoteContent, safeUrl };
