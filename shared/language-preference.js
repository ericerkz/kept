// Accept future catalogues as well as currently shipped languages, so older
// servers can retain a newer client's preference without changing sync format.
function normalizeLanguage(value) {
  if (value === 'system') return value;
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try { return Intl.getCanonicalLocales(value)[0] || null; } catch { return null; }
}
module.exports = { normalizeLanguage };
