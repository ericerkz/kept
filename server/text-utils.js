const { Parser } = require('htmlparser2');

function plainText(value) {
  const text = [];
  let hidden = false;
  const parser = new Parser({
    onopentagname(name) {
      if (name === 'script' || name === 'style') { hidden = true; text.push(' '); }
    },
    ontext(value) { if (!hidden) text.push(value); },
    onclosetag(name) {
      if (name === 'script' || name === 'style') { hidden = false; text.push(' '); }
    }
  }, { decodeEntities: true });
  parser.end(String(value || ''));
  return text.join('').replace(/\s+/g, ' ').trim();
}

function imageSources(value) {
  const sources = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === 'img' && attributes.src) sources.push(attributes.src);
    }
  }, { decodeEntities: true });
  parser.end(String(value || ''));
  return sources;
}

function validateEmail(value) {
  if (!value) return true; // Optional for administrator-created accounts.
  const email = String(value).trim();
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1), dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function stripTrailingSlashes(value) {
  const text = String(value ?? '');
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

module.exports = { plainText, imageSources, validateEmail, stripTrailingSlashes };
