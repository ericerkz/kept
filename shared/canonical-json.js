// Hash JSON content consistently after a native bridge reorders object fields.
// Normalize using ordinary JSON rules first (undefined, dates, non-finite values).
function canonicalJson(value) {
  const encode = item => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
  };
  return encode(JSON.parse(JSON.stringify(value)));
}

module.exports = { canonicalJson };
