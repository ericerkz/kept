import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sections = ['shared', 'android', 'ios'];
const manifestPath = 'translations/languages.json';
const reusePath = 'translations/reuse.json';
const cataloguePath = code => `translations/${code}.json`;

export function readJson(relative) {
  const raw = fs.readFileSync(path.join(root, relative), 'utf8');
  const result = JSON.parse(raw);
  // JSON.parse silently overwrites duplicate keys. Check each object separately:
  // the same message ID in two different platform sections is valid.
  let position = 0;
  const whitespace = () => { while (/\s/.test(raw[position] || '') && position < raw.length) position++; };
  function string() {
    const start = position++;
    while (position < raw.length) {
      if (raw[position] === '\\') { position += 2; continue; }
      if (raw[position++] === '"') break;
    }
    return JSON.parse(raw.slice(start, position));
  }
  function value(location) {
    whitespace();
    if (raw[position] === '{') {
      position++; whitespace(); const keys = new Set();
      while (raw[position] !== '}') {
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate key ${location}.${key} in ${relative}`);
        keys.add(key); whitespace(); position++; value(`${location}.${key}`); whitespace();
        if (raw[position] !== ',') break;
        position++; whitespace();
      }
      position++;
    } else if (raw[position] === '[') {
      position++; whitespace(); let index = 0;
      while (raw[position] !== ']') {
        value(`${location}[${index++}]`); whitespace();
        if (raw[position] !== ',') break;
        position++; whitespace();
      }
      position++;
    } else if (raw[position] === '"') string();
    else while (position < raw.length && !/[\s,}\]]/.test(raw[position])) position++;
  }
  value('$');
  return result;
}
function writeJson(relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function readCatalogue(code) {
  const file = cataloguePath(code), catalogue = readJson(file);
  if (!object(catalogue)) throw new Error(`${file} must contain language sections`);
  for (const key of Object.keys(catalogue)) if (!sections.includes(key)) throw new Error(`Unknown section ${key} in ${file}`);
  for (const section of sections) {
    if (catalogue[section] === undefined && code !== 'en') continue;
    if (!object(catalogue[section])) throw new Error(`${file}: ${section} must be a message object`);
  }
  return catalogue;
}

export function readReuse() { return readJson(reusePath); }
const validKey = key => /^[a-z0-9_.]+$/.test(key) && !['__proto__','constructor','prototype'].some(part => key.split('.').includes(part));
export function inspectReuse(source, reuse) {
  const errors = [];
  if (!object(reuse)) return ['Translation reuse mappings must be an object'];
  for (const [scope, mappings] of Object.entries(reuse)) {
    if (!sections.includes(scope) || !object(mappings)) { errors.push(`Invalid reuse scope ${scope}`); continue; }
    for (const [key, target] of Object.entries(mappings)) {
      if (!validKey(key)) { errors.push(`Invalid reused key ${scope}/${key}`); continue; }
      if (Object.hasOwn(source[scope] || {}, key)) errors.push(`${scope}/${key} must be translated only at its canonical entry`);
      const [targetScope, targetKey, extra] = typeof target === 'string' ? target.split('/') : [];
      // A target must be a real source message, never another alias. This also rules out cycles.
      if (!sections.includes(targetScope) || !validKey(targetKey || '') || extra !== undefined || !Object.hasOwn(source[targetScope] || {}, targetKey)) {
        errors.push(`Invalid reuse target for ${scope}/${key}: ${target}`);
      }
    }
  }
  return errors;
}

// Expand explicit aliases only in generated bundles, preserving every app's runtime IDs.
// Missing translations remain missing here so the exporter can apply English fallback.
export function messagesFor(catalogue, scope = 'shared', reuse = readReuse()) {
  if (!sections.includes(scope)) throw new Error(`Unknown UI scope ${scope}`);
  const messages = { ...catalogue[scope] };
  for (const [key, target] of Object.entries(reuse[scope] || {})) {
    const [targetScope, targetKey] = target.split('/');
    if (Object.hasOwn(catalogue[targetScope] || {}, targetKey)) messages[key] = catalogue[targetScope][targetKey];
  }
  return messages;
}
export const placeholders = text => [...String(text).matchAll(/{{\s*([A-Za-z_][A-Za-z_0-9]*)\s*}}/g)].map(match => match[1]).sort();
function containsSourceCode(value) {
  const text = value.replace(/{{\s*[A-Za-z_][A-Za-z_0-9]*\s*}}/g, '');
  return /^\s*[{});]\s*(?:[{}),;.]|\\n|\b(?:if|val|return|private)\b)/.test(text) || /^\s*,\s*\w+\.\w+\s*\(/.test(text) ||
    /\bfunction\s*(?:[A-Za-z_$][\w$]*\s*)?\([^)]*\)\s*\{|=>\s*\{/.test(text) ||
    /\b(?:const|let|var|val)\s+[A-Za-z_$][\w$]*\s*=|\bprivate\s+fun(?:c)?\s+\w+\s*\(/.test(text) ||
    /^\s*(?:if|while|catch)\s*\(|\b(?:localStorage|sessionStorage)\.\w+\s*\(/.test(text);
}
function canonical(code) {
  try { return typeof code === 'string' && code.length <= 64 && Intl.getCanonicalLocales(code)[0] === code; } catch { return false; }
}
export function inspectCatalogue(source, translated, language, complete = false) {
  const errors = [], missing = [];
  const plurals = new Set(Object.keys(source).filter(key => key.endsWith('.one') && Object.hasOwn(source, key.slice(0, -4) + '.other')).map(key => key.slice(0, -4)));
  for (const [key, value] of Object.entries(translated)) {
    if (!validKey(key)) errors.push(`Invalid key ${key}`);
    const plural = key.match(/^(.*)\.(zero|one|two|few|many|other)$/);
    const original = source[key] ?? (plural && plurals.has(plural[1]) ? source[`${plural[1]}.other`] : undefined);
    if (original === undefined) { errors.push(`Unknown key ${key}`); continue; }
    if (typeof value !== 'string') { errors.push(`${key} must be text`); continue; }
    if (/^data:[^,\s]+;base64,/i.test(value)) errors.push(`${key} contains embedded asset data instead of UI text`);
    if (/<\/?[A-Za-z!]|javascript:|<\s*script/i.test(value)) errors.push(`${key} contains markup or executable content`);
    if (containsSourceCode(value)) errors.push(`${key} contains source code instead of UI text`);
    if (!value.trim()) continue;
    if (JSON.stringify(placeholders(original)) !== JSON.stringify(placeholders(value))) errors.push(`${key} has different placeholders`);
  }
  for (const key of Object.keys(source)) if (typeof translated[key] !== 'string' || !translated[key].trim()) missing.push(key);
  for (const base of plurals) for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
    const key = `${base}.${category}`;
    if (!translated[key]?.trim() && !missing.includes(key)) missing.push(key);
  }
  if (complete && missing.length) errors.push(`${missing.length} messages are untranslated`);
  return { errors, missing };
}
export function check({ completeLanguage } = {}) {
  const manifest = readJson(manifestPath), source = readCatalogue('en'), errors = [], warnings = [];
  errors.push(...inspectReuse(source, readReuse()));
  if (manifest.sourceLanguage !== 'en') errors.push('English must remain the fallback');
  if (!Array.isArray(manifest.languages)) return { errors: [...errors, 'languages must be a list'], warnings };
  const codes = new Set();
  for (const language of manifest.languages) {
    if (!canonical(language.code) || codes.has(language.code)) { errors.push(`Invalid/duplicate language ${language.code}`); continue; }
    codes.add(language.code);
    if (!['ltr','rtl'].includes(language.direction) || typeof language.name !== 'string' || !language.name || typeof language.nativeName !== 'string' || !language.nativeName) errors.push(`Invalid metadata for ${language.code}`);
    if (!fs.existsSync(path.join(root, cataloguePath(language.code)))) { errors.push(`${cataloguePath(language.code)} is missing`); continue; }
    const catalogue = readCatalogue(language.code);
    for (const section of sections) {
      const translated = catalogue[section] || {};
      const result = inspectCatalogue(source[section], translated, language.code, language.code === 'en' || completeLanguage === language.code);
      errors.push(...result.errors.map(error => `${section}/${language.code}: ${error}`));
      if (result.missing.length) warnings.push(`${section}/${language.code}: ${result.missing.length} untranslated messages; English fallback applies`);
    }
  }
  if (!codes.has('en')) errors.push('English must remain in the language list');
  if (completeLanguage && !codes.has(completeLanguage)) errors.push(`Unregistered language ${completeLanguage}`);
  return { errors, warnings };
}
function option(args, name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i+1]; }
export function initializeLanguage(code, { name = code, nativeName = name, direction = 'ltr' } = {}) {
  if (!canonical(code) || !['ltr','rtl'].includes(direction)) throw new Error('Use a canonical BCP-47 language code and ltr/rtl direction');
  const manifest = readJson(manifestPath);
  if (manifest.languages.some(language => language.code === code) || fs.existsSync(path.join(root, cataloguePath(code)))) throw new Error('This language already exists; refusing to overwrite it');
  const source = readCatalogue('en'), catalogue = {};
  for (const section of sections) {
    const value = Object.fromEntries(Object.keys(source[section]).map(key => [key, '']));
    for (const key of Object.keys(source[section]).filter(key => key.endsWith('.other') && Object.hasOwn(source[section], key.slice(0,-6) + '.one'))) {
      for (const category of new Intl.PluralRules(code).resolvedOptions().pluralCategories) value[`${key.slice(0,-6)}.${category}`] ||= '';
    }
    catalogue[section] = Object.fromEntries(Object.entries(value).sort());
  }
  writeJson(cataloguePath(code), catalogue);
  manifest.languages.push({ code, name, nativeName, direction });
  writeJson(manifestPath, manifest);
}
function exportPlatform(scope, output) {
  if (!output) throw new Error('Provide --out <generated-directory>');
  const target = path.resolve(output), sources = path.join(root, 'translations');
  if (target === sources || target.startsWith(sources + path.sep)) throw new Error('Export outside the translation source directory');
  const result = check(); if (result.errors.length) throw new Error(result.errors.join('\n'));
  const manifest = readJson(manifestPath), languages = manifest.languages;
  fs.mkdirSync(target, { recursive:true });
  const previous = path.join(target, 'languages.json');
  if (fs.existsSync(previous)) {
    const old = JSON.parse(fs.readFileSync(previous, 'utf8'));
    for (const language of old.languages || []) if (canonical(language.code) && !languages.some(item => item.code === language.code)) fs.rmSync(path.join(target, `${language.code}.json`), { force:true });
  }
  const reuse = readReuse(), source = messagesFor(readCatalogue('en'), scope, reuse);
  const write = (filename, value) => {
    const text = JSON.stringify(value, null, 2) + '\n', destination = path.join(target, filename);
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== text) fs.writeFileSync(destination, text);
  };
  for (const language of languages) {
    const translated = messagesFor(readCatalogue(language.code), scope, reuse);
    const values = { ...source, ...Object.fromEntries(Object.entries(translated).filter(([, value]) => typeof value === 'string' && value.trim())) };
    write(`${language.code}.json`, values);
  }
  write('languages.json', { sourceLanguage:'en', languages });
}
export function exportNative(platform, output) {
  if (!['android','ios'].includes(platform)) throw new Error('Use export-native android|ios --out <generated-directory>');
  exportPlatform(platform, output);
}
export function exportWeb(output) { exportPlatform('shared', output); }
function watchWeb(output) {
  let timer;
  fs.watch(path.join(root, 'translations'), (_event, filename) => {
    if (filename && !String(filename).endsWith('.json')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { exportWeb(output); console.log('Updated bundled translations.'); }
      catch (error) { console.error(error.message); }
    }, 150);
  });
}
async function main(args) {
  const command = args[0] || 'check';
  if (command === 'init') initializeLanguage(args[1], { name:option(args,'--name',args[1]), nativeName:option(args,'--native-name',option(args,'--name',args[1])), direction:args.includes('--rtl') ? 'rtl' : 'ltr' });
  else if (command === 'export-native') exportNative(args[1], option(args,'--out',null));
  else if (command === 'export-web') { const output = option(args,'--out',null); exportWeb(output); if (args.includes('--watch')) watchWeb(output); }
  else if (!['check','stats'].includes(command)) throw new Error('Commands: check [--complete <code>], init <code>, export-web --out <directory> [--watch], export-native android|ios --out <directory>, stats');
  const result = check({ completeLanguage:option(args,'--complete',undefined) });
  for (const warning of result.warnings) console.warn(warning);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const source = readCatalogue('en');
  for (const section of sections) console.log(`${section}: ${Object.keys(source[section]).length} source messages`);
  console.log('Translation catalogues valid.');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
