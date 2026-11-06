const fs = require('node:fs');
const { isUtf8 } = require('node:buffer');

const SECRET_ENV_NAMES = Object.freeze([
  'KEPT_OIDC_CLIENT_SECRET',
  'KEPT_SMTP_USER',
  'KEPT_SMTP_PASS',
  'KEPT_SETUP_TOKEN',
  'KEPT_METRICS_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY'
]);
const MAX_SECRET_BYTES = 64 * 1024;

function readSecretFile(filename, setting) {
  let fd;
  try {
    // Nonblocking open lets us reject FIFOs rather than hanging at startup.
    // Follow symlinks: mounted secret volumes commonly use them.
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw new Error();
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (length > MAX_SECRET_BYTES || !isUtf8(bytes)) throw new Error();
    // Strip text-file line endings, not spaces that may belong to a password.
    const value = bytes.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || value.includes('\0')) throw new Error();
    return value;
  } catch {
    // Neither file contents nor the underlying exception belong in logs.
    throw new Error(`${setting} must point to a readable, non-empty UTF-8 regular file of at most 64 KiB, without NUL bytes.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadSecretFiles(env) {
  const values = Object.create(null);
  for (const name of SECRET_ENV_NAMES) {
    const setting = `${name}_FILE`;
    if (!env[setting]) continue;
    // Empty placeholders in Compose are equivalent to an unset direct value.
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`Set either ${name} or ${setting}, not both.`);
    }
    values[name] = readSecretFile(env[setting], setting);
  }
  return Object.freeze(values);
}

// CommonJS caches this module: files are read once, before server startup.
const fileSecrets = loadSecretFiles(process.env);
function secretValue(name) {
  if (!SECRET_ENV_NAMES.includes(name)) throw new Error('Unsupported secret setting.');
  return fileSecrets[name] ?? process.env[name] ?? '';
}

module.exports = { SECRET_ENV_NAMES, loadSecretFiles, secretValue };
