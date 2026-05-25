const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const path = require('path');
const cors = require('cors');
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const webPush = require('web-push');
const { WebSocket, WebSocketServer } = require('ws');
const { generateSecret, verifySync, generateURI } = require('otplib');
const qrcode = require('qrcode');

const app = express();
app.set('trust proxy', 1);
app.disable('etag');
const server = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, '..', 'data');
const uploadDir = path.join(dataDir, 'uploads');
const attachmentDir = path.join(dataDir, 'attachments');
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'kept.sqlite');
const vapidPath = path.join(dataDir, 'vapid.json');
const staticDir = path.join(__dirname, '..', 'dist', 'keep');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(attachmentDir, { recursive: true });

const KEPT_VERSION = (() => {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version || '0.0';
  } catch {
    return '0.0';
  }
})();
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ericerkz/kept/releases/latest';

function configureDatabase(database) {
  database.configure('busyTimeout', 5000);
  return database;
}

let db = configureDatabase(new sqlite3.Database(dbPath));
const SAFE_IMAGE_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);

// Attachment MIME types and extensions - restricted to prevent execution/interpretation
const SAFE_ATTACHMENT_TYPES = new Map([
  // Documents
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  // Text formats
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['text/markdown', '.md'],
  ['application/json', '.json'],
  ['application/xml', '.xml'],
  // Archives
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['multipart/x-zip', '.zip'],
  ['application/x-rar-compressed', '.rar'],
  ['application/vnd.rar', '.rar'],
  ['application/x-7z-compressed', '.7z'],
  ['application/gzip', '.gz'],
  ['application/x-gzip', '.gz'],
  ['application/x-tar', '.tar'],
  // Additional common formats
  ['application/vnd.oasis.opendocument.text', '.odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
  ['application/vnd.oasis.opendocument.presentation', '.odp']
]);

const SAFE_ATTACHMENT_EXTENSIONS = new Set(Array.from(SAFE_ATTACHMENT_TYPES.values()));

function generateTotpSecret() {
  return generateSecret();
}

function verifyTotpToken(token, secret) {
  try {
    const result = verifySync({ token: String(token), secret: String(secret) });
    return !!result.valid;
  } catch (e) {
    return false;
  }
}

function buildTotpKeyUri(username, issuer, secret) {
  return generateURI({ username, issuer, secret, label: username });
}

function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }

  if (fs.existsSync(vapidPath)) {
    return JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  }

  const keys = webPush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(keys, null, 2));
  return keys;
}

const vapidKeys = getVapidKeys();
// Apple's APNS gateway (used for iOS web push) validates the VAPID JWT
// `sub` claim and rejects reserved/private TLDs like `.local`, which
// causes pushes to iOS PWAs to silently fail (BadJwtToken). Use a
// publicly-routable mailto or https URL. Override with env var if needed.
const vapidSubject = process.env.VAPID_SUBJECT || 'https://example.com';
webPush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = SAFE_IMAGE_TYPES.get(String(file.mimetype || '').toLowerCase());
      if (!ext) return cb(new Error('Only PNG, JPG, GIF, and WEBP uploads are supported.'));
      cb(null, `${Date.now()}-${randomHex(12)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!SAFE_IMAGE_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Only PNG, JPG, GIF, and WEBP uploads are supported.'));
    }
    cb(null, true);
  }
});

const uploadAttachment = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, attachmentDir),
    filename: (_req, file, cb) => {
      const ext = safeAttachmentExtension(file);
      if (!ext) return cb(new Error('This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.'));
      // Generate randomized filename to prevent direct file access guessing
      cb(null, `att-${Date.now()}-${randomHex(16)}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    if (!safeAttachmentExtension(file)) {
      return cb(new Error('This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.'));
    }
    cb(null, true);
  }
});

// ─── Backup Logic ──────────────────────────────────────────────────────────

async function performBackup(isManual = false) {
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date().toISOString();
  const timestamp = now.replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}${isManual ? '-manual' : ''}.sqlite`;
  const destPath = path.join(backupDir, filename);

  return new Promise((resolve, reject) => {
    // Using VACUUM INTO for a safe, consistent backup
    db.run(`VACUUM INTO ?`, [destPath], async (err) => {
      if (err) {
        // Fallback to simple copy if VACUUM INTO is not supported or fails
        try {
          fs.copyFileSync(dbPath, destPath);
        } catch (copyErr) {
          return reject(copyErr);
        }
      }

      const setting = isManual ? 'lastManualBackupAt' : 'lastAutomatedBackupAt';
      await setAppSetting(setting, now);
      resolve(filename);
    });
  });
}


function startBackupScheduler() {
  setInterval(async () => {
    try {
      const schedule = await getAppSetting('backupSchedule', 'none');
      if (schedule === 'none') return;

      const backupTime = await getAppSetting('backupTime', '03:00');
      const lastBackupAt = await getAppSetting('lastAutomatedBackupAt', '');

      const now = new Date();
      const [hour, minute] = backupTime.split(':').map(Number);

      const targetToday = new Date(now);
      targetToday.setHours(hour, minute, 0, 0);


      // Don't backup if target time hasn't passed today
      if (now < targetToday) return;

      if (lastBackupAt) {
        const last = new Date(lastBackupAt);

        // If last backup was today, skip
        const isSameDay = last.getFullYear() === now.getFullYear() &&
                         last.getMonth() === now.getMonth() &&
                         last.getDate() === now.getDate();
        if (isSameDay) return;

        // Check intervals for non-daily schedules
        let daysToWait = 0;
        if (schedule === 'weekly') daysToWait = 7;
        if (schedule === 'monthly') daysToWait = 30;

        if (daysToWait > 0) {
          const diffDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
          if (diffDays < daysToWait) return;
        }
      }

      await performBackup();
      await setAppSetting('lastAutomatedBackupAt', now.toISOString());
      console.log(`[Backup] Automated ${schedule} backup completed at ${now.toISOString()}`);
    } catch (err) {
      console.error('Backup scheduler error:', err.message);
    }
  }, 60 * 1000); // Check every minute
}




function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

let perfRequestSeq = 0;
function createPerfTrace(name, details = {}) {
  const id = ++perfRequestSeq;
  const start = process.hrtime.bigint();
  let last = start;
  const elapsed = (from = start) => Number(process.hrtime.bigint() - from) / 1e6;
  const detailText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[KeptPerf:server] ${name}#${id} start${detailText}`);
  return {
    id,
    mark(label, extra = {}) {
      const now = process.hrtime.bigint();
      const delta = Number(now - last) / 1e6;
      last = now;
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeptPerf:server] ${name}#${id} ${label} +${delta.toFixed(1)}ms total=${elapsed().toFixed(1)}ms${extraText}`);
    },
    end(extra = {}) {
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeptPerf:server] ${name}#${id} end total=${elapsed().toFixed(1)}ms${extraText}`);
    }
  };
}

function sendJsonWithPerf(res, trace, payload) {
  const serializeStart = process.hrtime.bigint();
  const body = JSON.stringify(payload);
  const serializeMs = Number(process.hrtime.bigint() - serializeStart) / 1e6;
  trace.mark('serialize', { ms: Number(serializeMs.toFixed(1)), bytes: Buffer.byteLength(body) });
  res.type('application/json').send(body);
  trace.end({ bytes: Buffer.byteLength(body) });
}

function plainText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function init() {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      theme TEXT NOT NULL DEFAULT 'light',
      avatarDataUrl TEXT,
      avatarPreset TEXT NOT NULL DEFAULT 'cat',
      createdAt TEXT NOT NULL
    )
  `);
  const userColumns = await all('PRAGMA table_info(users)');
  if (!userColumns.some(column => column.name === 'theme')) {
    await run(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'`);
  }
  if (!userColumns.some(column => column.name === 'avatarDataUrl')) {
    await run(`ALTER TABLE users ADD COLUMN avatarDataUrl TEXT`);
  }
  if (!userColumns.some(column => column.name === 'avatarPreset')) {
    await run(`ALTER TABLE users ADD COLUMN avatarPreset TEXT NOT NULL DEFAULT 'cat'`);
  }
  if (!userColumns.some(column => column.name === 'icsFeedToken')) {
    await run(`ALTER TABLE users ADD COLUMN icsFeedToken TEXT`);
  }
  if (!userColumns.some(column => column.name === 'totpSecret')) {
    await run(`ALTER TABLE users ADD COLUMN totpSecret TEXT`);
  }
  if (!userColumns.some(column => column.name === 'totpEnabled')) {
    await run(`ALTER TABLE users ADD COLUMN totpEnabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColumns.some(column => column.name === 'totpBackupCodes')) {
    await run(`ALTER TABLE users ADD COLUMN totpBackupCodes TEXT`);
  }
  if (!userColumns.some(column => column.name === 'email')) {
    await run(`ALTER TABLE users ADD COLUMN email TEXT`);
  }
  if (!userColumns.some(column => column.name === 'enabled')) {
    await run(`ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!userColumns.some(column => column.name === 'demoNotesCreatedAt')) {
    await run(`ALTER TABLE users ADD COLUMN demoNotesCreatedAt TEXT`);
  }
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const sessionColumns = await all('PRAGMA table_info(sessions)');
  if (!sessionColumns.some(column => column.name === 'expiresAt')) {
    await run(`ALTER TABLE sessions ADD COLUMN expiresAt TEXT`);
  }
  // Purge expired sessions on startup
  await run('DELETE FROM sessions WHERE expiresAt IS NOT NULL AND expiresAt <= ?', [new Date().toISOString()]);
  await run(`
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, name)
    )
  `);
  const labelSchemaRow = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'`);
  const labelsUsesLegacyUnique = String(labelSchemaRow?.sql || '').includes('name TEXT NOT NULL UNIQUE');
  if (labelsUsesLegacyUnique) {
    await run('ALTER TABLE labels RENAME TO labels_legacy');
    const legacyLabelColumns = await all('PRAGMA table_info(labels_legacy)');
    const legacyHasUserId = legacyLabelColumns.some(column => column.name === 'userId');
    await run(`
      CREATE TABLE labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        name TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(userId, name)
      )
    `);
    if (legacyHasUserId) {
      await run(`
        INSERT INTO labels (id, userId, name)
        SELECT id, COALESCE(userId, (SELECT id FROM users ORDER BY role = 'admin' DESC, id LIMIT 1), 1), name
        FROM labels_legacy
      `);
    } else {
      await run(`
        INSERT INTO labels (id, userId, name)
        SELECT id, COALESCE((SELECT id FROM users ORDER BY role = 'admin' DESC, id LIMIT 1), 1), name
        FROM labels_legacy
      `);
    }
    await run('DROP TABLE labels_legacy');
  }
  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerUserId INTEGER,
      noteTitle TEXT NOT NULL,
      noteBody TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      bgColor TEXT NOT NULL DEFAULT '',
      bgImage TEXT NOT NULL DEFAULT '',
      checkBoxes TEXT NOT NULL DEFAULT '[]',
      images TEXT NOT NULL DEFAULT '[]',
      isCbox INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0,
      sortOrder REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      isDemo INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(ownerUserId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const noteColumns = await all('PRAGMA table_info(notes)');
  if (!noteColumns.some(column => column.name === 'isDemo')) {
    await run(`ALTER TABLE notes ADD COLUMN isDemo INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'ownerUserId')) {
    await run(`ALTER TABLE notes ADD COLUMN ownerUserId INTEGER`);
  }
  if (!noteColumns.some(column => column.name === 'trashedAt')) {
    await run(`ALTER TABLE notes ADD COLUMN trashedAt TEXT`);
  }
  if (!noteColumns.some(column => column.name === 'images')) {
    await run(`ALTER TABLE notes ADD COLUMN images TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!noteColumns.some(column => column.name === 'lastEditorUserId')) {
    await run(`ALTER TABLE notes ADD COLUMN lastEditorUserId INTEGER`);
  }
  if (!noteColumns.some(column => column.name === 'sortOrder')) {
    await run(`ALTER TABLE notes ADD COLUMN sortOrder REAL NOT NULL DEFAULT 0`);
  }
  await run('UPDATE notes SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL');
  const firstUser = await get('SELECT id FROM users ORDER BY role = "admin" DESC, id LIMIT 1');
  if (firstUser) {
    await run('UPDATE notes SET ownerUserId = ? WHERE ownerUserId IS NULL', [firstUser.id]);
    await run('UPDATE labels SET userId = ? WHERE userId IS NULL', [firstUser.id]);
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS labels_user_name_unique ON labels(userId, name)');
  await run(`
    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      ownerUserId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storedFilename TEXT NOT NULL,
      originalName TEXT NOT NULL,
      fileSize INTEGER NOT NULL,
      mimeType TEXT NOT NULL,
      uploadedAt TEXT NOT NULL,
      UNIQUE(noteId, storedFilename)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS note_images_note_idx ON note_images(noteId)`);
  await run(`CREATE INDEX IF NOT EXISTS note_images_filename_idx ON note_images(storedFilename)`);
  await run(`
    CREATE TABLE IF NOT EXISTS note_collaborators (
      noteId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(noteId, userId),
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_pins (
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      PRIMARY KEY(userId, noteId),
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_note_positions (
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      sortOrder REAL NOT NULL,
      PRIMARY KEY(userId, noteId),
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dueAtUtc TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      repeatRule TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fired','dismissed','snoozed')),
      title TEXT,
      body TEXT,
      imageUrl TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  const reminderColumns = await all('PRAGMA table_info(reminders)');
  if (!reminderColumns.some(column => column.name === 'imageUrl')) {
    await run(`ALTER TABLE reminders ADD COLUMN imageUrl TEXT`);
  }
  if (!reminderColumns.some(column => column.name === 'gcalEventId')) {
    await run(`ALTER TABLE reminders ADD COLUMN gcalEventId TEXT`);
  }
  await run(`CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(userId)`);
  await run(`CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(dueAtUtc, status)`);
  // Performance indexes for the /api/notes query, which JOINs by note id and
  // filters by ownerUserId. Without these, listing all notes degrades to
  // O(n*m) scans once the user has hundreds of notes (visible after a takeout
  // import). Indexes are cheap to maintain.
  await run(`CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes(ownerUserId, trashed)`);
  await run(`CREATE INDEX IF NOT EXISTS note_collaborators_user_idx ON note_collaborators(userId, noteId)`);
  await run(`CREATE INDEX IF NOT EXISTS note_collaborators_note_idx ON note_collaborators(noteId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS note_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      originalName TEXT NOT NULL,
      storedFilename TEXT NOT NULL UNIQUE,
      fileSize INTEGER NOT NULL,
      mimeType TEXT NOT NULL,
      uploadedAt TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS note_attachments_note_idx ON note_attachments(noteId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS note_collaborator_rejoin_grants (
      noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantedAt TEXT NOT NULL,
      PRIMARY KEY (noteId, userId)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS update_dismissals (
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      dismissedAt TEXT NOT NULL,
      forever INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, version)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(userId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS caldav_settings (
      userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      serverUrl TEXT NOT NULL DEFAULT '',
      calendarUrl TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS google_calendar_tokens (
      userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      clientId TEXT NOT NULL,
      clientSecret TEXT NOT NULL,
      accessToken TEXT,
      refreshToken TEXT,
      tokenExpiry TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS ai_action_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      transcript TEXT NOT NULL,
      proposedPlanJson TEXT NOT NULL,
      executedPlanJson TEXT,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  const originalAdminUserId = await getAppSetting('originalAdminUserId', '');
  if (!originalAdminUserId) {
    const firstUser = await get('SELECT id FROM users ORDER BY id LIMIT 1');
    if (firstUser) await setAppSetting('originalAdminUserId', String(firstUser.id));
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    theme: user.theme || 'light',
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    totpEnabled: !!user.totpEnabled,
    hasBackupCodes: !!user.totpBackupCodes,
    email: user.email || '',
    enabled: user.enabled !== undefined ? !!user.enabled : true,
    createdAt: user.createdAt,
    demoNotesCreatedAt: user.demoNotesCreatedAt || null
  };
}

function publicCollaborator(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    shareCount: user.shareCount || 0
  };
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeAttachmentExtension(file) {
  const mimeType = String(file?.mimetype || '').toLowerCase();
  const expectedExt = SAFE_ATTACHMENT_TYPES.get(mimeType);
  if (!expectedExt) return '';

  const originalExt = path.extname(String(file?.originalname || '')).toLowerCase();
  if (!originalExt || !SAFE_ATTACHMENT_EXTENSIONS.has(originalExt)) return '';
  if (mimeType !== 'text/plain' && originalExt !== expectedExt) return '';
  return originalExt;
}

function safeDownloadName(name) {
  const base = path.basename(String(name || 'attachment'));
  return base.replace(/[\r\n"]/g, '_') || 'attachment';
}

function attachmentPath(storedFilename) {
  const filename = path.basename(String(storedFilename || ''));
  const primary = path.join(attachmentDir, filename);
  if (fs.existsSync(primary)) return primary;
  return path.join(uploadDir, filename);
}

async function deleteAttachmentFilesForNote(noteId) {
  const attachments = await all('SELECT storedFilename FROM note_attachments WHERE noteId = ?', [noteId]);
  for (const attachment of attachments) {
    const filePath = attachmentPath(attachment.storedFilename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(randomHex(4).toUpperCase());
  return codes;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function randomAvatarPreset() {
  const presets = ['cat', 'fox', 'bunny', 'bear', 'panda', 'guinea-pig', 'capybara'];
  return presets[Math.floor(Math.random() * presets.length)];
}

const SESSION_TTL_DAYS = Number(process.env.KEPT_SESSION_TTL_DAYS || 30);
async function createSession(user) {
  const token = randomHex(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await run(
    'INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)',
    [token, user.id, now.toISOString(), expiresAt]
  );
  return { token, user: publicUser(user) };
}

function validateEmail(email) {
  if (!email) return true; // optional for admin-created users
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).trim());
}

async function getAppSetting(key, defaultValue) {
  const row = await get('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

async function setAppSetting(key, value) {
  await run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

async function isOriginalAdminUser(userId) {
  const originalAdminUserId = Number(await getAppSetting('originalAdminUserId', '0'));
  return Number(userId) === originalAdminUserId;
}

async function deleteOwnedFilesForUser(userId) {
  const ownedNotes = await all('SELECT id FROM notes WHERE ownerUserId = ?', [userId]);
  for (const note of ownedNotes) {
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
  }

  const unlinkedImages = await all('SELECT storedFilename FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  await run('DELETE FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  for (const row of unlinkedImages) {
    const filename = safeStoredImageFilename(row.storedFilename);
    if (!filename) continue;
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [filename]);
    if (stillUsed) continue;
    try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {}
  }
}

async function deleteUserAndOwnedData(userId) {
  await deleteOwnedFilesForUser(userId);
  await run('DELETE FROM users WHERE id = ?', [userId]);
}

async function createUser({ username, displayName, password, role, email, enabled, totpSecret, totpBackupCodes }) {
  const cleanUsername = normalizeUsername(username);
  const cleanDisplayName = String(displayName || '').trim() || cleanUsername;
  const cleanPassword = String(password || '');
  const cleanEmail = email ? String(email).trim() : null;

  if (cleanUsername.length < 3) {
    const error = new Error('Username must be at least 3 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanPassword.length < 8) {
    const error = new Error('Password must be at least 8 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanEmail && !validateEmail(cleanEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }

  const passwordSalt = randomHex(16);
  const passwordHash = hashPassword(cleanPassword, passwordSalt);
  const createdAt = new Date().toISOString();
  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

  const hasTotp = !!totpSecret;
  const result = await run(
    `INSERT INTO users (username, displayName, role, passwordHash, passwordSalt, theme, avatarPreset, email, enabled, totpSecret, totpEnabled, totpBackupCodes, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cleanUsername, cleanDisplayName, role, passwordHash, passwordSalt, 'light', randomAvatarPreset(), cleanEmail, isEnabled, totpSecret || null, hasTotp ? 1 : 0, totpBackupCodes || null, createdAt]
  );
  return await get('SELECT * FROM users WHERE id = ?', [result.id]);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const PRIVATE_IMAGE_PREFIX = '/api/uploads/images/';

function safeStoredImageFilename(filename) {
  const clean = String(filename || '').trim();
  if (!/^[0-9]+-[a-f0-9]{24}\.(png|jpe?g|gif|webp)$/i.test(clean)) return '';
  return clean;
}

function localImageFilenameFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:')) return '';
  let pathname = raw;
  try {
    pathname = new URL(raw, 'http://kept.local').pathname;
  } catch {}
  const match = pathname.match(/^(?:\/uploads\/|\/api\/uploads\/images\/)([^/?#]+)$/);
  if (!match) return '';
  try {
    return safeStoredImageFilename(decodeURIComponent(match[1]));
  } catch {
    return safeStoredImageFilename(match[1]);
  }
}

function canonicalImageUrl(value) {
  const filename = localImageFilenameFromUrl(value);
  return filename ? `${PRIVATE_IMAGE_PREFIX}${filename}` : value;
}

function canonicalizeNoteHtmlImages(html) {
  return String(html || '').replace(/(\bsrc=["'])([^"']+)(["'])/gi, (_match, before, src, after) => {
    return `${before}${canonicalImageUrl(src)}${after}`;
  });
}

function canonicalizeNoteImages(images) {
  return (Array.isArray(images) ? images : []).map(image => {
    if (!image || typeof image !== 'object') return image;
    return { ...image, dataUrl: canonicalImageUrl(image.dataUrl) };
  });
}

function canonicalizeNotePayload(payload) {
  return {
    ...payload,
    noteBody: canonicalizeNoteHtmlImages(payload.noteBody || ''),
    images: canonicalizeNoteImages(payload.images || [])
  };
}

function imageMimeType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extractNoteImageFilenames(note) {
  const filenames = new Set();
  const body = String(note?.noteBody || '');
  for (const match of body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const filename = localImageFilenameFromUrl(match[1]);
    if (filename) filenames.add(filename);
  }
  for (const image of Array.isArray(note?.images) ? note.images : []) {
    const filename = localImageFilenameFromUrl(image?.dataUrl);
    if (filename) filenames.add(filename);
  }
  return [...filenames];
}

function dbNoteToApi(row) {
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    noteTitle: row.noteTitle,
    noteBody: row.noteBody || '',
    pinned: Boolean(pinned),
    bgColor: row.bgColor || '',
    bgImage: row.bgImage || '',
    checkBoxes: parseJson(row.checkBoxes, []),
    images: parseJson(row.images || '[]', []),
    isCbox: Boolean(row.isCbox),
    labels: parseJson(row.labels, []),
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    trashedAt: row.trashedAt || '',
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    collaborators: parseJson(row.collaborators || '[]', []),
    ownerDisplayName: row.ownerDisplayName || undefined,
    ownerUsername: row.ownerUsername || undefined,
    ownerAvatarDataUrl: row.ownerAvatarDataUrl || undefined,
    ownerAvatarPreset: row.ownerAvatarPreset || undefined,
    lastEditorUserId: row.lastEditorUserId || undefined,
    lastEditorDisplayName: row.lastEditorDisplayName || undefined,
    isDemo: Boolean(row.isDemo)
  };
}

function notePreviewText(row) {
  const bodyText = plainText(row.noteBody || '');
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const checklistText = Array.isArray(checkBoxes)
    ? checkBoxes.map(item => plainText(item?.data || '')).filter(Boolean).join(' ')
    : '';
  return (bodyText || checklistText || '').slice(0, 280);
}

function noteLinkCount(row) {
  const urls = new Set();
  const addUrls = (value) => {
    for (const match of String(value || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = match[0].replace(/[),.;:!?]+$/, '');
      if (url) urls.add(url);
    }
  };
  addUrls(row.noteBody || '');
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  if (Array.isArray(checkBoxes)) checkBoxes.forEach(item => addUrls(item?.data || ''));
  return urls.size;
}

function searchTextFromQuery(query) {
  return String(query || '')
    .split(/\s+/)
    .filter(token => token &&
      !/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/i.test(token) &&
      !/^!l(?:a(?:b(?:e(?:l(?::[a-z0-9_-]+)?)?)?)?)?$/i.test(token) &&
      !/^!label:[a-z0-9_-]+$/i.test(token) &&
      !/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/i.test(token) &&
      !/^!t(?:o(?:d(?:o)?)?)?$/i.test(token) &&
      !/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/i.test(token) &&
      !/^!url?$/i.test(token)
    )
    .join(' ')
    .trim();
}

function searchTokensFromQuery(query) {
  return searchTextFromQuery(query)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/:\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function noteSearchWhere(tokens) {
  const params = [];
  const conditions = tokens.map(token => {
    const like = `%${token}%`;
    params.push(like, like, like, like, like);
    return `(LOWER(COALESCE(noteTitle, '')) LIKE ?
      OR LOWER(COALESCE(noteBody, '')) LIKE ?
      OR LOWER(COALESCE(checkBoxes, '')) LIKE ?
      OR LOWER(COALESCE(labels, '')) LIKE ?
      OR LOWER(COALESCE(attachmentNames, '')) LIKE ?)`;
  });
  return { clause: conditions.join(' AND '), params };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cardNoteBody(row, previewText) {
  const body = row.noteBody || '';
  if (/<img\b/i.test(body)) return body;
  if (row.isCbox && !plainText(body).trim()) return '';
  return escapeHtml(previewText);
}

function cardSearchText(row) {
  return [
    row.noteTitle || '',
    row.noteBody || '',
    row.checkBoxes || '',
    row.labels || '',
    row.attachmentNames || ''
  ].join(' ');
}

function dbNoteToCard(row, options = {}) {
  const includeSearchText = !!options.includeSearchText;
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  const labels = parseJson(row.labels || '[]', []);
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const parsedImages = parseJson(row.images || '[]', []);
  const images = Array.isArray(parsedImages) ? parsedImages.filter(Boolean) : [];
  const previewText = notePreviewText(row);
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    noteTitle: row.noteTitle,
    noteBody: cardNoteBody(row, previewText),
    searchText: includeSearchText ? cardSearchText(row) : undefined,
    previewText,
    linkCount: noteLinkCount(row),
    pinned: Boolean(pinned),
    bgColor: row.bgColor || '',
    bgImage: row.bgImage || '',
    checkBoxes: Array.isArray(checkBoxes) ? checkBoxes.slice(0, 8) : [],
    images,
    hasMoreImages: false,
    isCbox: Boolean(row.isCbox),
    labels,
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    trashedAt: row.trashedAt || '',
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments: [],
    hasAttachments: Number(row.attachmentCount || 0) > 0,
    attachmentCount: Number(row.attachmentCount || 0),
    collaborators: parseJson(row.collaborators || '[]', []),
    ownerDisplayName: row.ownerDisplayName || undefined,
    ownerUsername: row.ownerUsername || undefined,
    ownerAvatarDataUrl: row.ownerAvatarDataUrl || undefined,
    ownerAvatarPreset: row.ownerAvatarPreset || undefined,
    lastEditorUserId: row.lastEditorUserId || undefined,
    lastEditorDisplayName: row.lastEditorDisplayName || undefined,
    isDemo: Boolean(row.isDemo),
    isCardPreview: true
  };
}

function noteSummaryFromRow(row) {
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const labels = parseJson(row.labels || '[]', []);
  const collaboratorIds = row.collaboratorIds
    ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
    : [];
  const hasChecklist = Array.isArray(checkBoxes) && checkBoxes.length > 0;
  const hasDrawing = String(row.images || '').includes('"id":"drawing"') || String(row.images || '').includes('"id": "drawing"');
  return {
    id: row.id,
    title: row.noteTitle || '',
    bodyPreview: notePreviewText(row),
    type: hasDrawing ? 'drawing' : (row.isCbox || hasChecklist ? 'todo' : 'text'),
    labels,
    checklistPreview: hasChecklist ? checkBoxes.slice(0, 6).map(item => ({
      id: item.id,
      data: plainText(item.data || ''),
      done: !!item.done
    })) : [],
    updatedAt: row.updatedAt,
    ownerUserId: row.ownerUserId,
    collaboratorUserIds: collaboratorIds
  };
}

async function accessibleNoteSummaryRows(userId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
  const query = String(options.query || '').trim();
  const noteId = Number(options.noteId || 0);
  const searchTokens = searchTokensFromQuery(query);
  const searchWhere = noteSearchWhere(searchTokens);
  const whereClauses = [];
  const params = [userId, userId, userId, userId];

  if (noteId) {
    whereClauses.push('id = ?');
    params.push(noteId);
  }
  if (searchWhere.clause) {
    whereClauses.push(searchWhere.clause);
    params.push(...searchWhere.params);
  }
  const extraWhere = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return await all(
    `WITH accessible_notes AS (
      SELECT notes.*,
             COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder,
             CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
             (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
             (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
      FROM notes
      LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
      LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
      LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
      WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
    )
    SELECT * FROM accessible_notes
    ${extraWhere}
    ORDER BY updatedAt DESC, id DESC
    LIMIT ?`,
    [...params, limit]
  );
}

async function accessibleNoteSummaries(userId, options = {}) {
  const rows = await accessibleNoteSummaryRows(userId, options);
  return rows.map(noteSummaryFromRow);
}

const SMART_ACTION_TYPES = new Set([
  'create_text_note',
  'create_todo_note',
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'set_reminder',
  'share_note',
  'archive_note',
  'trash_note'
]);

const NOTE_TARGET_ACTION_TYPES = new Set([
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'share_note',
  'archive_note',
  'trash_note'
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function actionNoteId(action) {
  return Number(action.noteId || action.targetNoteId || action.targetId || 0);
}

function resolveActionNoteId(action, state) {
  return action.noteId || state.lastCreatedNoteId || null;
}

function actionText(action) {
  return String(action.text ?? action.body ?? action.content ?? action.noteBody ?? '').trim();
}

function actionTitle(action) {
  return String(action.title ?? action.noteTitle ?? '').trim();
}

function actionChecklistItems(action) {
  return asArray(action.items ?? action.checklistItems ?? action.todos).map(item => {
    if (typeof item === 'string') return item.trim();
    return String(item?.data ?? item?.text ?? item?.title ?? '').trim();
  }).filter(Boolean);
}

function actionLabelNames(action) {
  return asArray(action.labels ?? action.labelNames ?? action.names).map(label => {
    if (typeof label === 'string') return label.trim();
    return String(label?.name ?? '').trim();
  }).filter(Boolean);
}

function actionUserIds(action) {
  return asArray(action.userIds ?? action.users ?? action.collaboratorUserIds ?? action.shareWithUserIds)
    .map(user => Number(typeof user === 'object' ? user?.id : user))
    .filter(Boolean);
}

function normalizeAction(action) {
  let type = String(action?.type || '').trim();
  if (['archive', 'archiveNote'].includes(type)) type = 'archive_note';
  if (['trash', 'trashNote'].includes(type)) type = 'trash_note';
  const normalized = { ...action, type };
  if (actionNoteId(action)) normalized.noteId = actionNoteId(action);
  const title = actionTitle(action);
  if (title) normalized.title = title;
  const text = actionText(action);
  if (text) normalized.text = text;
  const checklistItems = actionChecklistItems(action);
  if (checklistItems.length) normalized.items = checklistItems;
  const labelNames = actionLabelNames(action);
  if (labelNames.length) normalized.labels = labelNames;
  const userIds = actionUserIds(action);
  if (userIds.length) normalized.userIds = userIds;
  if (action.dueAtUtc || action.dueAt || action.datetime || action.dateTime) {
    normalized.dueAtUtc = String(action.dueAtUtc || action.dueAt || action.datetime || action.dateTime);
  }
  if (action.timezone) normalized.timezone = String(action.timezone);
  if (action.repeatRule) normalized.repeatRule = String(action.repeatRule);
  if (action.createMissingLabels !== undefined) normalized.createMissingLabels = !!action.createMissingLabels;
  return normalized;
}

function reminderNoteTextFromTranscript(transcript) {
  return String(transcript || '')
    .replace(/\b(can you|please|could you)\b/gi, ' ')
    .replace(/\b(remind me|reminder|set a reminder|create a reminder)\b/gi, ' ')
    .replace(/\b(today|tomorrow|tonight|this evening|this morning|this afternoon)\b/gi, ' ')
    .replace(/\b(at|by|around)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*to\s+/i, '')
    .trim();
}

function fallbackReminderNoteText(action, transcript) {
  return action.text || action.title || reminderNoteTextFromTranscript(transcript) || String(transcript || '').trim() || 'Reminder';
}

function normalizeActionPlan(actionPlan, transcript = '') {
  const input = actionPlan && typeof actionPlan === 'object' ? actionPlan : {};
  const rawActions = Array.isArray(input.actions) ? input.actions.map(normalizeAction) : [];
  const actions = [];
  let createdNoteAvailable = false;
  for (const action of rawActions) {
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      const noteText = fallbackReminderNoteText(action, transcript);
      actions.push({
        type: 'create_text_note',
        title: action.title || noteText,
        text: action.text || noteText
      });
      createdNoteAvailable = true;
    }
    actions.push(action);
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }
  const confidence = ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'medium';
  return {
    summary: String(input.summary || '').trim(),
    confidence,
    requiresConfirmation: !!input.requiresConfirmation,
    actions,
    unresolvedQuestions: asArray(input.unresolvedQuestions).map(String).filter(Boolean)
  };
}

function actionRequiresCreatedNote(action) {
  return !action.noteId && (
    NOTE_TARGET_ACTION_TYPES.has(action.type) ||
    action.type === 'set_reminder'
  );
}

function selectedActionsWithDependencies(actions, selected) {
  if (!selected) return actions;
  const expanded = new Set(selected);
  let latestCreateIndex = null;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (expanded.has(index) && actionRequiresCreatedNote(action) && latestCreateIndex !== null) {
      expanded.add(latestCreateIndex);
    }
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      latestCreateIndex = index;
    }
  }
  return actions.filter((_action, index) => expanded.has(index));
}

async function findOrCreateLabelForUser(userId, rawName) {
  const name = String(rawName || '').trim();
  if (!name) {
    const error = new Error('Label name is required.');
    error.status = 400;
    throw error;
  }
  const existing = await get('SELECT id, name FROM labels WHERE userId = ? AND lower(name) = lower(?)', [userId, name]);
  if (existing) return { ...existing, created: false };
  const result = await run('INSERT INTO labels (name, userId) VALUES (?, ?)', [name, userId]);
  return { id: result.id, name, created: true };
}

async function findLabelForUser(userId, rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  return await get('SELECT id, name FROM labels WHERE userId = ? AND lower(name) = lower(?)', [userId, name]);
}

async function validateKeptActionPlan(userId, transcript, actionPlan) {
  const normalizedPlan = normalizeActionPlan(actionPlan, transcript);
  const errors = [];
  const warnings = [];
  const noteCache = new Map();
  let risky = normalizedPlan.requiresConfirmation || normalizedPlan.confidence === 'low' || normalizedPlan.actions.length > 1;

  if (!String(transcript || '').trim()) warnings.push('Transcript is empty.');
  if (!normalizedPlan.summary) warnings.push('Plan summary is empty.');
  if (!Array.isArray(actionPlan?.actions)) errors.push('actions must be an array.');
  if (!normalizedPlan.actions.length) errors.push('At least one action is required.');

  let createdNoteAvailable = false;
  for (let index = 0; index < normalizedPlan.actions.length; index += 1) {
    const action = normalizedPlan.actions[index];
    const label = `actions[${index}]`;
    if (!SMART_ACTION_TYPES.has(action.type)) {
      errors.push(`${label}.type is not supported.`);
      continue;
    }

    if (NOTE_TARGET_ACTION_TYPES.has(action.type) && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (['append_to_note'].includes(action.type) && !action.text) errors.push(`${label}.text is required.`);
    if (action.type === 'create_text_note' && !action.title && !action.text) errors.push(`${label}.title or text is required.`);
    if (action.type === 'create_todo_note' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_checklist_items' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_labels' && !action.labels?.length) errors.push(`${label}.labels are required.`);
    if (action.type === 'set_reminder' && !action.dueAtUtc) {
      risky = true;
      warnings.push(`${label}.dueAtUtc is missing; ask for a reminder time before executing.`);
      if (!normalizedPlan.unresolvedQuestions.includes('When should Kept remind you?')) {
        normalizedPlan.unresolvedQuestions.push('When should Kept remind you?');
      }
    }
    if (action.type === 'share_note') {
      risky = true;
      if (!action.userIds?.length) errors.push(`${label}.userIds are required.`);
    }

    if (action.noteId && !noteCache.has(action.noteId)) {
      noteCache.set(action.noteId, await getAccessibleNote(action.noteId, userId));
    }
    let note = action.noteId ? noteCache.get(action.noteId) : null;
    if (action.type === 'share_note' && action.noteId && createdNoteAvailable && (!note || note.ownerUserId !== userId)) {
      warnings.push(`${label}.noteId was ignored because a previous action creates the note to share.`);
      delete action.noteId;
      note = null;
    }
    if (action.noteId && !note) errors.push(`${label}.noteId is not accessible.`);
    if (action.type === 'share_note' && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to share it.`);
    }
    if ((action.type === 'archive_note' || action.type === 'trash_note') && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to ${action.type === 'archive_note' ? 'archive' : 'trash'} it.`);
    }

    if (action.type === 'share_note') {
      for (const userIdTarget of action.userIds || []) {
        const user = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [userIdTarget]);
        if (!user) errors.push(`${label}.userIds contains an unknown user: ${userIdTarget}.`);
        if (userIdTarget === userId) warnings.push(`${label}.userIds includes the current user; it will be ignored.`);
      }
    }

    if (action.type === 'add_labels' && !action.createMissingLabels) {
      for (const labelName of action.labels || []) {
        const existingLabel = await findLabelForUser(userId, labelName);
        if (!existingLabel) errors.push(`${label}.labels contains an unknown label: ${labelName}.`);
      }
    }

    if (action.type === 'set_reminder' && action.dueAtUtc) {
      const due = new Date(action.dueAtUtc);
      if (Number.isNaN(due.getTime())) errors.push(`${label}.dueAtUtc must be a valid date.`);
      else action.dueAtUtc = due.toISOString();
    }

    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }

  normalizedPlan.requiresConfirmation = risky;
  return {
    valid: errors.length === 0,
    ok: errors.length === 0,
    errors,
    warnings,
    normalizedPlan,
    requiresConfirmation: normalizedPlan.requiresConfirmation
  };
}

async function insertAiActionHistory(userId, transcript, proposedPlan, executedPlan, status) {
  await run(
    `INSERT INTO ai_action_history (userId, transcript, proposedPlanJson, executedPlanJson, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      String(transcript || ''),
      JSON.stringify(proposedPlan || null),
      executedPlan ? JSON.stringify(executedPlan) : null,
      status,
      new Date().toISOString()
    ]
  );
}

async function smartCreateNote(userId, action, options = {}) {
  const now = new Date().toISOString();
  const isTodo = action.type === 'create_todo_note';
  const labels = [];
  for (const name of action.labels || []) {
    const label = await findOrCreateLabelForUser(userId, name);
    labels.push({ id: label.id, name: label.name, added: true });
    if (label.created) options.createdLabelIds?.add(label.id);
  }
  const checkBoxes = isTodo
    ? (action.items || []).map((item, index) => ({ id: Date.now() + index, data: item, done: false }))
    : [];
  const result = await run(
    `INSERT INTO notes
	     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
	     VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?, 0, 0, NULL, ?, ?, ?, ?, 0)`,
	    [
	      userId,
	      action.title || '',
	      isTodo ? (action.text || '') : (action.text || ''),
	      String(action.bgColor || ''),
	      JSON.stringify(checkBoxes),
      isTodo ? 1 : 0,
      JSON.stringify(labels),
      Date.now(),
      now,
      now,
      userId
    ]
  );
  return result.id;
}

async function smartAppendToNote(userId, noteId, text) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const separator = note.noteBody && String(note.noteBody).trim() ? '<br>' : '';
  const nextBody = `${note.noteBody || ''}${separator}${escapeHtml(text)}`;
  await run('UPDATE notes SET noteBody = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    nextBody,
    new Date().toISOString(),
    userId,
    noteId
  ]);
  await syncNoteImagesForNote(noteId, note.ownerUserId, { noteBody: nextBody, images: parseJson(note.images || '[]', []) });
}

async function smartAddChecklistItems(userId, noteId, items) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const current = parseJson(note.checkBoxes || '[]', []);
  const base = Date.now();
  const next = [
    ...current,
    ...items.map((item, index) => ({ id: base + index, data: item, done: false }))
  ];
  await run('UPDATE notes SET checkBoxes = ?, isCbox = 1, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(next),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartAddLabels(userId, noteId, labelNames, createdLabelIds, createMissingLabels = false) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  if (note.ownerUserId !== userId) throw new Error(`Only the note owner can change labels for note ${noteId}.`);
  const labels = parseJson(note.labels || '[]', []);
  const byName = new Map(labels.map(label => [String(label.name || '').toLowerCase(), label]));
  for (const name of labelNames) {
    const label = createMissingLabels
      ? await findOrCreateLabelForUser(userId, name)
      : await findLabelForUser(userId, name);
    if (!label) throw new Error(`Label does not exist: ${name}`);
    if (createMissingLabels && label.created) createdLabelIds.add(label.id);
    const key = label.name.toLowerCase();
    if (!byName.has(key)) {
      const entry = { id: label.id, name: label.name, added: true };
      labels.push(entry);
      byName.set(key, entry);
    }
  }
  await run('UPDATE notes SET labels = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(labels),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartSetReminder(userId, action, fallbackNoteId) {
  const noteId = action.noteId || fallbackNoteId || null;
  if (noteId) {
    const note = await getAccessibleNote(Number(noteId), userId);
    if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  }
  const now = new Date().toISOString();
  const result = await run(
    `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      noteId || null,
      userId,
      new Date(action.dueAtUtc).toISOString(),
      action.timezone || 'UTC',
      action.repeatRule || null,
      plainText(action.title) || null,
      plainText(action.text) || null,
      String(action.imageUrl || '') || null,
      now,
      now
    ]
  );
  return await get('SELECT * FROM reminders WHERE id = ?', [result.id]);
}

async function smartShareNote(userId, noteId, userIds) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const previousRecipients = await getNoteRecipientIds(noteId);
  for (const targetUserId of new Set(userIds.filter(id => id !== userId))) {
    const exists = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [targetUserId]);
    if (!exists) throw new Error(`User ${targetUserId} does not exist.`);
    await run(
      'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)',
      [noteId, targetUserId, new Date().toISOString()]
    );
  }
  return previousRecipients;
}

async function setOwnedNoteLifecycleState(userId, noteId, updates) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const now = new Date().toISOString();
  const next = {
    archived: updates.archived === undefined ? !!note.archived : !!updates.archived,
    trashed: updates.trashed === undefined ? !!note.trashed : !!updates.trashed
  };
  const trashedAt = nextTrashedAt(note, next);
  await run(
    'UPDATE notes SET archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?',
    [next.archived ? 1 : 0, next.trashed ? 1 : 0, trashedAt, now, userId, noteId]
  );
  return {
    noteId,
    archived: next.archived,
    trashed: next.trashed,
    trashedAt: trashedAt || '',
    updatedAt: now
  };
}

async function executeSmartAction(userId, action, state) {
  const result = { type: action.type, ok: true };
  if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
    const noteId = await smartCreateNote(userId, action, state);
    state.createdNoteIds.push(noteId);
    state.lastCreatedNoteId = noteId;
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'append_to_note') {
    const noteId = resolveActionNoteId(action, state);
    await smartAppendToNote(userId, noteId, action.text);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_checklist_items') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddChecklistItems(userId, noteId, action.items || []);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_labels') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddLabels(userId, noteId, action.labels || [], state.createdLabelIds, !!action.createMissingLabels);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'set_reminder') {
    const reminder = await smartSetReminder(userId, action, state.lastCreatedNoteId);
    state.reminderIds.push(reminder.id);
    state.remindersToSync.push(reminder);
    if (reminder.noteId) state.updatedNoteIds.add(reminder.noteId);
    result.reminderId = reminder.id;
    result.noteId = reminder.noteId || null;
    return result;
  }
  if (action.type === 'share_note') {
    const noteId = resolveActionNoteId(action, state);
    const previousRecipients = await smartShareNote(userId, noteId, action.userIds || []);
    state.updatedNoteIds.add(noteId);
    state.shareBroadcasts.push({ noteId, previousRecipients });
    result.noteId = noteId;
    result.userIds = (action.userIds || []).filter(id => id !== userId);
    return result;
  }
  if (action.type === 'archive_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: true, trashed: false });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  if (action.type === 'trash_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: false, trashed: true });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  throw new Error(`Unsupported action type: ${action.type}`);
}

async function syncSmartReminderIntegrations(userId, reminders) {
  if (!reminders.length) return;
  const enrichedReminders = await enrichReminderResponses(reminders);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [userId]);
  for (const reminder of enrichedReminders) {
    if (caldav) pushReminderToCaldav(caldav, reminder).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(userId, reminder).catch(err => console.error('GCal push failed:', err.message));
  }
}

function encodeNotesCursor(row) {
  if (!row) return null;
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  return Buffer.from(JSON.stringify({
    pinned: Number(pinned || 0),
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    id: Number(row.id)
  })).toString('base64url');
}

function decodeNotesCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const pinned = Number(parsed.pinned || 0);
    const sortOrder = Number(parsed.sortOrder);
    const id = Number(parsed.id);
    if (!Number.isFinite(pinned) || !Number.isFinite(sortOrder) || !Number.isFinite(id)) return null;
    return { pinned, sortOrder, id };
  } catch {
    return null;
  }
}

async function cleanupUnusedLabels(userId) {
  try {
    const notes = await all('SELECT labels FROM notes WHERE ownerUserId = ?', [userId]);
    const usedLabelNames = new Set();
    notes.forEach(note => {
      const labels = parseJson(note.labels, []);
      labels.forEach(l => {
        if (l.name) usedLabelNames.add(l.name);
      });
    });

    const allLabels = await all('SELECT id, name FROM labels WHERE userId = ?', [userId]);
    for (const label of allLabels) {
      if (!usedLabelNames.has(label.name)) {
        await run('DELETE FROM labels WHERE id = ?', [label.id]);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup labels:', error);
  }
}

function noteToParams(note) {
  return [
    String(note.noteTitle || ''),
    String(note.noteBody || ''),
    note.pinned ? 1 : 0,
    String(note.bgColor || ''),
    String(note.bgImage || ''),
    JSON.stringify(note.checkBoxes || []),
    JSON.stringify(note.images || []),
    note.isCbox ? 1 : 0,
    JSON.stringify(note.labels || []),
    note.archived ? 1 : 0,
    note.trashed ? 1 : 0
  ];
}

function nextTrashedAt(previous, next) {
  if (!next.trashed) return null;
  return previous?.trashed ? (previous.trashedAt || new Date().toISOString()) : new Date().toISOString();
}

function trashExpirationCutoff() {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
}

async function purgeExpiredTrashedNotes() {
  const expired = await all('SELECT id FROM notes WHERE trashed = 1 AND trashedAt IS NOT NULL AND trashedAt <= ?', [trashExpirationCutoff()]);
  for (const note of expired) {
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
  }
  await run('DELETE FROM notes WHERE trashed = 1 AND trashedAt IS NOT NULL AND trashedAt <= ?', [trashExpirationCutoff()]);
}

let trashPurgeRunning = false;
let lastTrashPurgeAt = 0;
function scheduleTrashPurgeIfStale() {
  const now = Date.now();
  if (trashPurgeRunning || now - lastTrashPurgeAt < 60 * 60 * 1000) return;
  trashPurgeRunning = true;
  lastTrashPurgeAt = now;
  setTimeout(() => {
    purgeExpiredTrashedNotes()
      .catch(error => console.error('[Trash purge] failed:', error))
      .finally(() => { trashPurgeRunning = false; });
  }, 10000).unref?.();
}

async function syncNoteImagesForNote(noteId, ownerUserId, note) {
  if (!noteId || !ownerUserId) return;
  const filenames = extractNoteImageFilenames(note);
  await run('DELETE FROM note_images WHERE noteId = ?', [noteId]);
  for (const filename of filenames) {
    const filePath = path.join(uploadDir, filename);
    let stats = null;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    const existingUnlinked = await get(
      'SELECT id FROM note_images WHERE storedFilename = ? AND noteId IS NULL AND ownerUserId = ? ORDER BY id LIMIT 1',
      [filename, ownerUserId]
    );
    if (existingUnlinked) {
      await run(
        'UPDATE note_images SET noteId = ?, fileSize = ?, mimeType = ? WHERE id = ?',
        [noteId, stats.size, imageMimeType(filename), existingUnlinked.id]
      );
    } else {
      await run(
        `INSERT OR IGNORE INTO note_images
         (noteId, ownerUserId, storedFilename, originalName, fileSize, mimeType, uploadedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [noteId, ownerUserId, filename, filename, stats.size, imageMimeType(filename), new Date().toISOString()]
      );
    }
  }
}

async function deleteImageFilesForNote(noteId) {
  const rows = await all('SELECT storedFilename FROM note_images WHERE noteId = ?', [noteId]);
  await run('DELETE FROM note_images WHERE noteId = ?', [noteId]);
  for (const row of rows) {
    const filename = safeStoredImageFilename(row.storedFilename);
    if (!filename) continue;
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [filename]);
    if (stillUsed) continue;
    try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {}
  }
}

async function backfillExistingNoteImages() {
  const rows = await all('SELECT id, ownerUserId, noteBody, images FROM notes WHERE ownerUserId IS NOT NULL');
  for (const row of rows) {
    const note = {
      noteBody: canonicalizeNoteHtmlImages(row.noteBody || ''),
      images: canonicalizeNoteImages(parseJson(row.images || '[]', []))
    };
    await syncNoteImagesForNote(row.id, row.ownerUserId, note);
    if (note.noteBody !== (row.noteBody || '') || JSON.stringify(note.images) !== (row.images || '[]')) {
      await run('UPDATE notes SET noteBody = ?, images = ? WHERE id = ?', [note.noteBody, JSON.stringify(note.images), row.id]);
    }
  }
}

async function runStartupMaintenance() {
  const imageBackfillCompleted = await getAppSetting('noteImagesBackfillCompleted', '');
  if (!imageBackfillCompleted) {
    await backfillExistingNoteImages();
    await setAppSetting('noteImagesBackfillCompleted', new Date().toISOString());
  }

  const now = new Date().toISOString();
  await run(
    `UPDATE notes
     SET trashedAt = COALESCE(updatedAt, createdAt, ?)
     WHERE trashed = 1 AND trashedAt IS NULL`,
    [now]
  );
  await run('UPDATE notes SET trashedAt = NULL WHERE trashed = 0');
  await purgeExpiredTrashedNotes();
}

function scheduleStartupMaintenance() {
  setTimeout(() => {
    runStartupMaintenance()
      .catch(error => console.error('[Startup maintenance] failed:', error));
  }, 5000).unref?.();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
const rateBuckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const bucketKey = `${key}:${(typeof key === 'function' ? key(req) : req.ip)}`;
    const now = Date.now();
    let bucket = rateBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Periodically prune stale buckets to keep memory bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, 60_000).unref?.();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: 'login' });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: 'register' });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: 'setup' });

const totpFailures = new Map(); // userId -> { count, lockedUntil }
function checkTotpLock(userId) {
  const entry = totpFailures.get(userId);
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function recordTotpFailure(userId) {
  const entry = totpFailures.get(userId) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000;
    entry.count = 0;
  }
  totpFailures.set(userId, entry);
}
function clearTotpFailures(userId) { totpFailures.delete(userId); }

async function resolveSessionFromToken(token) {
  if (!token) return null;
  return await get(
    `SELECT users.*, sessions.expiresAt AS sessionExpiresAt FROM sessions
     JOIN users ON users.id = sessions.userId
     WHERE sessions.token = ? AND users.enabled = 1
       AND (sessions.expiresAt IS NULL OR sessions.expiresAt > ?)`,
    [token, new Date().toISOString()]
  );
}

async function requireAuth(req, res, next) {
  const perfAuthStart = process.hrtime.bigint();
  try {
    const header = req.header('authorization') || '';
    // Token must be in the Authorization header — querystring tokens leak via
    // logs and Referer. (WebSocket and ICS feed endpoints intentionally do
    // their own token handling.)
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    const session = await resolveSessionFromToken(token);
    if (!session) return res.status(401).json({ error: 'Authentication required.' });

    req.user = session;
    req.token = token;
    if (req.path === '/api/notes' || req.path === '/api/admin/update-status') {
      const authMs = Number(process.hrtime.bigint() - perfAuthStart) / 1e6;
      console.log(`[KeptPerf:server] auth ${req.method} ${req.path} ${authMs.toFixed(1)}ms`);
    }
    next();
  } catch (error) {
    next(error);
  }
}

// For endpoints loaded as page assets (e.g. <img src="...">) where the
// browser can't attach an Authorization header. Accepts the token via the
// `token` query param in addition to the header.
async function requireAuthOrQueryToken(req, res, next) {
  try {
    const header = req.header('authorization') || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token && req.query.token) token = String(req.query.token);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const session = await resolveSessionFromToken(token);
    if (!session) return res.status(401).json({ error: 'Authentication required.' });
    req.user = session;
    req.token = token;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

async function getAccessibleNote(noteId, userId) {
  return await get(
    `SELECT notes.*, CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
     lastEditor.displayName AS lastEditorDisplayName FROM notes
     LEFT JOIN note_collaborators ON note_collaborators.noteId = notes.id AND note_collaborators.userId = ?
     LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
     LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
     WHERE notes.id = ? AND (notes.ownerUserId = ? OR note_collaborators.userId IS NOT NULL)`,
    [userId, userId, noteId, userId]
  );
}

async function getOwnedNote(noteId, userId) {
  return await get('SELECT * FROM notes WHERE id = ? AND ownerUserId = ?', [noteId, userId]);
}

async function getCollaboratorsForNote(noteId) {
  const rows = await all(
    `SELECT users.id, users.username, users.displayName, users.avatarDataUrl, users.avatarPreset
     FROM note_collaborators
     JOIN users ON users.id = note_collaborators.userId
     WHERE note_collaborators.noteId = ?
     ORDER BY users.displayName, users.username`,
    [noteId]
  );
  return rows.map(u => ({
    ...publicCollaborator(u),
    online: realtimeClients.has(u.id)
  }));
}

const realtimeClients = new Map();

function addRealtimeClient(userId, socket) {
  if (!realtimeClients.has(userId)) {
    realtimeClients.set(userId, new Set());
    broadcastRealtimeToAll({ type: 'global-presence', userId, online: true });
  }
  realtimeClients.get(userId).add(socket);
  socket.on('close', () => {
    const sockets = realtimeClients.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (!sockets.size) {
      realtimeClients.delete(userId);
      broadcastRealtimeToAll({ type: 'global-presence', userId, online: false });
    }
  });
}

function closeRealtimeClientsForUser(userId, reason = 'Account disabled.') {
  const sockets = realtimeClients.get(userId);
  if (!sockets) return;
  sockets.forEach(socket => {
    try {
      socket.close(1008, reason);
    } catch {}
  });
  realtimeClients.delete(userId);
  broadcastRealtimeToAll({ type: 'global-presence', userId, online: false });
}

function broadcastRealtime(userIds, payload) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  const message = JSON.stringify({ ...payload, at: new Date().toISOString() });

  uniqueUserIds.forEach(userId => {
    const sockets = realtimeClients.get(userId);
    if (!sockets) return;
    sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
  });
}

function broadcastRealtimeToAll(data) {
  const message = JSON.stringify({ ...data, at: new Date().toISOString() });
  realtimeClients.forEach((sockets) => {
    sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
  });
}

async function getNoteRecipientIds(noteId) {
  const rows = await all(
    `SELECT ownerUserId AS userId FROM notes WHERE id = ?
     UNION
     SELECT userId FROM note_collaborators WHERE noteId = ?`,
    [noteId, noteId]
  );
  return rows.map(row => row.userId).filter(Boolean);
}

async function broadcastNoteChange(noteId, action, userIds) {
  const recipients = userIds || await getNoteRecipientIds(noteId);
  const payload = { type: 'notes-changed', action, noteId };
  broadcastRealtime(recipients, payload);
  setTimeout(() => {
    broadcastRealtime(recipients, { ...payload, followup: true });
  }, 1200);
}

async function broadcastProfileUpdate(user) {
  const rows = await all(
    `SELECT ? AS userId
     UNION
     SELECT nc.userId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE n.ownerUserId = ?
     UNION
     SELECT n.ownerUserId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE nc.userId = ?
     UNION
     SELECT nc2.userId
     FROM note_collaborators nc
     JOIN note_collaborators nc2 ON nc2.noteId = nc.noteId
     WHERE nc.userId = ?`,
    [user.id, user.id, user.id, user.id]
  );
  broadcastRealtime(rows.map(row => row.userId), {
    type: 'profile-updated',
    user: publicCollaborator(user)
  });
}

const notePresence = new Map();
const socketPresence = new Map();

async function broadcastPresenceUpdate(noteId) {
  const activeUserIds = Array.from(notePresence.get(noteId) || []);
  let activeEditors = [];
  if (activeUserIds.length > 0) {
    const placeholders = activeUserIds.map(() => '?').join(',');
    activeEditors = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset
       FROM users WHERE id IN (${placeholders})`,
      activeUserIds
    );
  }
  const recipients = await getNoteRecipientIds(noteId);
  broadcastRealtime(recipients, { type: 'presence-update', noteId, activeEditors });
}

function setupRealtime() {
  const wss = new WebSocketServer({ server, path: '/api/realtime' });

  wss.on('connection', async (socket, req) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token') || '';
      const session = await get(
        `SELECT users.* FROM sessions
         JOIN users ON users.id = sessions.userId
         WHERE sessions.token = ? AND users.enabled = 1
           AND (sessions.expiresAt IS NULL OR sessions.expiresAt > ?)`,
        [token, new Date().toISOString()]
      );

      if (!session) {
        socket.close(1008, 'Authentication required.');
        return;
      }

      addRealtimeClient(session.id, socket);

      socket.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'join-note') {
            const noteId = Number(msg.noteId);
            if (!Number.isFinite(noteId) || noteId <= 0) return;
            // Only allow presence join for notes the user actually has access to.
            // Without this, anyone could enumerate note ids and broadcast their
            // presence to every collaborator on those notes.
            const accessible = await getAccessibleNote(noteId, session.id);
            if (!accessible) return;
            socketPresence.set(socket, noteId);
            if (!notePresence.has(noteId)) notePresence.set(noteId, new Set());
            notePresence.get(noteId).add(session.id);
            await broadcastPresenceUpdate(noteId);
          } else if (msg.type === 'leave-note') {
            const noteId = msg.noteId;
            socketPresence.delete(socket);
            if (notePresence.has(noteId)) {
              notePresence.get(noteId).delete(session.id);
              if (notePresence.get(noteId).size === 0) notePresence.delete(noteId);
              await broadcastPresenceUpdate(noteId);
            }
          }
        } catch (e) {
          console.error('Invalid WS message', e);
        }
      });

      socket.on('close', async () => {
        const socketsForUser = realtimeClients.get(session.id);
        if (socketsForUser) {
          socketsForUser.delete(socket);
          if (socketsForUser.size === 0) {
            realtimeClients.delete(session.id);
            broadcastRealtimeToAll({ type: 'global-presence', userId: session.id, online: false });
          }
        }
        const noteId = socketPresence.get(socket);
        if (noteId) {
          socketPresence.delete(socket);
          if (notePresence.has(noteId)) {
            notePresence.get(noteId).delete(session.id);
            if (notePresence.get(noteId).size === 0) notePresence.delete(noteId);
            await broadcastPresenceUpdate(noteId);
          }
        }
      });

      socket.send(JSON.stringify({ type: 'ready', at: new Date().toISOString() }));
    } catch (error) {
      console.error(error);
      socket.close(1011, 'Realtime setup failed.');
    }
  });
}

// ─── CalDAV helpers ────────────────────────────────────────────────────────

function toIcalDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function buildVCalendar(reminder) {
  const esc = s => String(s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
  const dtend = toIcalDate(new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString());
  const body = (reminder.body || '').trim();
  const attribution = '— Created by Kept ✨';
  const description = body ? `${body}\n\n\n${attribution}` : attribution;
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Kept//Kept//EN',
    'BEGIN:VEVENT',
    `UID:kept-reminder-${reminder.id}@kept`,
    `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
    `DTSTART:${toIcalDate(reminder.dueAtUtc)}`,
    `DTEND:${dtend}`,
    `SUMMARY:${esc(reminder.title || 'Kept Reminder')}`,
    `DESCRIPTION:${esc(description)}`,
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

function caldavRequest(settings, reminderId, method, body) {
  const https = require('https');
  const http = require('http');
  let base = settings.calendarUrl;
  if (!base.endsWith('/')) base += '/';
  const url = new URL(`${base}kept-reminder-${reminderId}.ics`);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = proto.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        ...(bodyBuf ? { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': bodyBuf.length } : {})
      }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve(res.statusCode);
      else reject(new Error(`CalDAV ${method} failed: HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function pushReminderToCaldav(settings, reminder) {
  await caldavRequest(settings, reminder.id, 'PUT', buildVCalendar(reminder));
}

async function deleteReminderFromCaldav(settings, reminderId) {
  await caldavRequest(settings, reminderId, 'DELETE', null);
}

function buildReminderPushPayload(reminder) {
  return JSON.stringify({
    type: 'reminder-fired',
    reminderId: reminder.id,
    noteId: reminder.noteId,
    title: plainText(reminder.title) || 'Reminder',
    body: plainText(reminder.body),
    imageUrl: reminder.imageUrl || null,
    icon: '/assets/images/keep2x.png',
    deepLink: reminder.deepLink || (reminder.noteId ? `kept://note/${reminder.noteId}` : null),
    url: '/'
  });
}

async function sendReminderPush(reminder) {
  const subscriptions = await all(
    'SELECT id, subscription FROM push_subscriptions WHERE userId = ?',
    [reminder.userId]
  );
  const payload = buildReminderPushPayload(reminder);

  await Promise.all(subscriptions.map(async row => {
    try {
      await webPush.sendNotification(JSON.parse(row.subscription), payload);
    } catch (error) {
      const sub = JSON.parse(row.subscription);
      const endpoint = sub.endpoint || '';
      const isApple = endpoint.includes('web.push.apple.com');
      if (error.statusCode === 404 || error.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
        console.warn(`Web Push: ${isApple ? '[Apple]' : ''} subscription gone (${error.statusCode}), removed.`);
      } else {
        console.error(
          `Web Push failed${isApple ? ' [Apple/iOS]' : ''}:`,
          'status=', error.statusCode,
          'body=', error.body,
          'msg=', error.message
        );
      }
    }
  }));
}

function testCaldavConnection(settings) {
  const https = require('https');
  const http = require('http');
  const url = new URL(settings.calendarUrl);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = proto.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'PROPFIND',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/xml', 'Depth': '0' }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve({ status: res.statusCode });
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── ICS feed helpers ─────────────────────────────────────────────────────

function buildIcsFeed(reminders, calName = 'Kept Reminders') {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const attribution = '— Created by Kept ✨';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kept//Kept//EN',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-CALDESC:Reminders from Kept',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'
  ];
  for (const r of reminders) {
    const dtend = toIcalDate(new Date(new Date(r.dueAtUtc).getTime() + 30 * 60000).toISOString());
    const body = (r.body || '').trim();
    const description = body ? `${body}\n\n\n${attribution}` : attribution;
    lines.push('BEGIN:VEVENT',
      `UID:kept-reminder-${r.id}@kept`,
      `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
      `DTSTART:${toIcalDate(r.dueAtUtc)}`,
      `DTEND:${dtend}`,
      `SUMMARY:${esc(r.title || 'Kept Reminder')}`,
      `DESCRIPTION:${esc(description)}`,
      r.status !== 'pending' ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function getOrCreateIcsFeedToken(userId) {
  const user = await get('SELECT icsFeedToken FROM users WHERE id = ?', [userId]);
  if (user?.icsFeedToken) return user.icsFeedToken;
  const token = randomHex(20);
  await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, userId]);
  return token;
}

function parseIcsContent(icsContent) {
  const lines = icsContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT' && cur) { events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).replace(/;[^:]+/g, '').toUpperCase();
    const val = line.slice(ci + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    if (key === 'DTSTART') cur.dtstart = val;
    if (key === 'SUMMARY') cur.summary = val;
    if (key === 'DESCRIPTION') cur.description = val;
  }
  return events;
}

function parseIcalDate(dtstr) {
  const s = String(dtstr || '').replace(/[-:]/g, '');
  const isUtc = s.endsWith('Z');
  const clean = s.replace('T', '').replace('Z', '');
  const y = clean.slice(0, 4), mo = clean.slice(4, 6), da = clean.slice(6, 8);
  const hr = clean.slice(8, 10) || '00', mi = clean.slice(10, 12) || '00', sc = clean.slice(12, 14) || '00';
  return new Date(`${y}-${mo}-${da}T${hr}:${mi}:${sc}${isUtc ? 'Z' : 'Z'}`);
}

// ─── Google Calendar helpers ───────────────────────────────────────────────

const oauthStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) { if (v.createdAt < cutoff) oauthStates.delete(k); }
}, 5 * 60 * 1000);

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(String(body), 'utf8');
    const req = require('https').request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsApiCall(method, path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const buf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    const req = require('https').request(
      { hostname: 'www.googleapis.com', path, method, headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function exchangeGoogleCode(clientId, clientSecret, code, redirectUri) {
  const params = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error(result.body?.error_description || 'Token exchange failed.');
  return result.body;
}

async function refreshGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error('Token refresh failed.');
  return result.body;
}

async function getValidGoogleToken(userId) {
  const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ? AND enabled = 1 AND accessToken IS NOT NULL', [userId]);
  if (!row) return null;
  const expiry = row.tokenExpiry ? new Date(row.tokenExpiry) : null;
  if (!expiry || expiry <= new Date(Date.now() + 60000)) {
    if (!row.refreshToken) return null;
    try {
      const refreshed = await refreshGoogleAccessToken(row.clientId, row.clientSecret, row.refreshToken);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await run('UPDATE google_calendar_tokens SET accessToken = ?, tokenExpiry = ?, updatedAt = ? WHERE userId = ?',
        [refreshed.access_token, newExpiry, new Date().toISOString(), userId]);
      return refreshed.access_token;
    } catch { return null; }
  }
  return row.accessToken;
}

function buildGCalEvent(reminder) {
  const end = new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString();
  const body = reminder.body || '';
  const attribution = '— Created by Kept ✨';
  const description = body ? `${body}\n\n${attribution}` : attribution;
  return {
    summary: reminder.title || 'Kept Reminder',
    description,
    start: { dateTime: reminder.dueAtUtc, timeZone: reminder.timezone || 'UTC' },
    end: { dateTime: end, timeZone: reminder.timezone || 'UTC' },
    colorId: '6',
    extendedProperties: { private: { keptReminderId: String(reminder.id) } }
  };
}

async function gcalCreateAndStore(userId, reminder, token) {
  const result = await httpsApiCall('POST', '/calendar/v3/calendars/primary/events', token, buildGCalEvent(reminder));
  if ((result.status === 200 || result.status === 201) && result.body?.id) {
    await run('UPDATE reminders SET gcalEventId = ? WHERE id = ?', [result.body.id, reminder.id]);
  }
}

async function gcalPushReminder(userId, reminder) {
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  if (reminder.gcalEventId) {
    const result = await httpsApiCall('PUT', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, buildGCalEvent(reminder));
    if (result.status === 404) await gcalCreateAndStore(userId, reminder, token);
  } else {
    await gcalCreateAndStore(userId, reminder, token);
  }
}

async function gcalDeleteReminder(userId, reminder) {
  if (!reminder.gcalEventId) return;
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  await httpsApiCall('DELETE', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, null);
}

// ─── Reminder scheduler ────────────────────────────────────────────────────

function startReminderScheduler() {
  setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const due = await all(
        `SELECT reminders.* FROM reminders
         ${visibleReminderJoin}
         WHERE reminders.status = 'pending'
         AND reminders.dueAtUtc <= ?
         AND ${visibleReminderWhere}`,
        [now]
      );
      const enrichedDue = await enrichReminderResponses(due);
      for (const reminder of enrichedDue) {
        await run(`UPDATE reminders SET status = 'fired', updatedAt = ? WHERE id = ?`, [now, reminder.id]);
        broadcastRealtime([reminder.userId], {
          type: 'reminder-fired',
          reminderId: reminder.id,
          noteId: reminder.noteId,
          title: reminder.title,
          body: reminder.body,
          imageUrl: reminder.imageUrl
        });
        sendReminderPush(reminder).catch(err => console.error('Reminder push failed:', err.message));
      }
    } catch (err) {
      console.error('Reminder scheduler error:', err.message);
    }
  }, 15_000);
}

// CORS configuration.
//
// By default the SPA is served same-origin so no CORS headers are needed.
// Two opt-in modes for cross-origin deployments:
//
//   KEPT_CORS_ALLOW_ALL=1
//     Send `Access-Control-Allow-Origin: *` to every request, no credential
//     mode. Fine for personal/family self-hosted instances where you don't
//     want to fight allowlist syntax. Authenticated calls still need a valid
//     Bearer token (Kept doesn't use cookies), so an attacker site can't
//     read user data — but it does expose the unauth endpoints (login,
//     register, setup status) to direct browser fetch from anywhere. See
//     docker-compose.yml for the full security tradeoff.
//
//   KEPT_CORS_ORIGINS=https://app.example.com,https://kept.example.com
//     Comma-separated allowlist. Most secure of the three. Required if you
//     ever switch Kept to cookie-based sessions.
//
// If both are set, the explicit allowlist wins.
const corsAllowlist = String(process.env.KEPT_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (corsAllowlist.length) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      cb(null, corsAllowlist.includes(origin));
    },
    credentials: true
  }));
} else if (process.env.KEPT_CORS_ALLOW_ALL === '1') {
  app.use(cors({ origin: '*' }));
}
app.use('/api', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  next();
});
app.use(express.json({ limit: '25mb' }));

app.get('/api/setup/status', asyncRoute(async (_req, res) => {
  const row = await get('SELECT COUNT(*) AS count FROM users');
  res.json({ hasUsers: row.count > 0 });
}));

app.post('/api/setup/admin', setupLimiter, asyncRoute(async (req, res) => {
  const row = await get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) return res.status(409).json({ error: 'Initial setup is already complete.' });

  const { totpSecret, totpToken, ...userData } = req.body;
  let backupCodes = null;

  if (totpSecret) {
    if (!totpToken) return res.status(400).json({ error: 'A 2FA code is required to enable 2FA.' });
    const isValid = verifyTotpToken(totpToken, totpSecret);
    if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code.' });
    backupCodes = generateBackupCodes();
  }

  const user = await createUser({ ...userData, role: 'admin', totpSecret: totpSecret || null, totpBackupCodes: backupCodes ? JSON.stringify(backupCodes) : null });
  await setAppSetting('originalAdminUserId', String(user.id));
  res.status(201).json({ user: publicUser(user), backupCodes });
}));

app.post('/api/setup/restore', setupLimiter, multer({ dest: path.join(dataDir, 'backups') }).single('backup'), asyncRoute(async (req, res) => {
  // Guard: even if all users are deleted, restore must be explicitly enabled
  // by the operator via KEPT_ALLOW_RESTORE=1. Otherwise an attacker who can
  // wipe the DB could swap in an arbitrary SQLite to take over.
  if (process.env.KEPT_ALLOW_RESTORE !== '1') {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(403).json({ error: 'Restore is disabled. Set KEPT_ALLOW_RESTORE=1 on the server to enable.' });
  }
  const row = await get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(403).json({ error: 'Initial setup already complete.' });
  }

  if (!req.file) return res.status(400).json({ error: 'Backup file is required.' });

  const tempPath = req.file.path;

  // Validate the upload is actually a SQLite database (magic header).
  try {
    const fd = fs.openSync(tempPath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.toString('utf8', 0, 16) !== 'SQLite format 3\0') {
      try { fs.unlinkSync(tempPath); } catch {}
      return res.status(400).json({ error: 'File is not a valid SQLite backup.' });
    }
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch {}
    return res.status(400).json({ error: 'Could not read backup file.' });
  }

  // Close the current DB connection
  await new Promise((resolve, reject) => {
    db.close((err) => err ? reject(err) : resolve());
  });

  try {
    // Replace the file
    fs.copyFileSync(tempPath, dbPath);
    fs.unlinkSync(tempPath);

    // Re-open and re-init
    db = configureDatabase(new sqlite3.Database(dbPath));
    await init();

    res.json({ success: true });
  } catch (e) {
    // Attempt to recover current DB if possible
    db = configureDatabase(new sqlite3.Database(dbPath));
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = await get('SELECT * FROM users WHERE username = ?', [username]);

  if (!user || hashPassword(password, user.passwordSalt) !== user.passwordHash) {
    return res.status(401).json({ error: 'Username or password is incorrect.' });
  }

  if (!user.enabled) {
    return res.status(403).json({ error: 'Your account is pending approval by an administrator.' });
  }

  if (user.totpEnabled) {
    const lockedFor = checkTotpLock(user.id);
    if (lockedFor > 0) {
      return res.status(429).json({ error: `Too many invalid 2FA attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.` });
    }

    const token = String(req.body.totpToken || '').trim();
    if (!token) {
      return res.status(401).json({ error: '2FA required', requires2FA: true });
    }

    let isValid = false;
    // Check if it's a standard 6-digit TOTP
    if (token.length === 6) {
      isValid = verifyTotpToken(token, user.totpSecret);
    } else if (token.length === 8 && user.totpBackupCodes) {
      // Check backup codes
      let backupCodes = [];
      try { backupCodes = JSON.parse(user.totpBackupCodes); } catch {}
      const codeIndex = backupCodes.indexOf(token.toUpperCase());
      if (codeIndex > -1) {
        isValid = true;
        backupCodes.splice(codeIndex, 1);
        await run('UPDATE users SET totpBackupCodes = ? WHERE id = ?', [JSON.stringify(backupCodes), user.id]);
      }
    }

    if (!isValid) {
      recordTotpFailure(user.id);
      return res.status(401).json({ error: 'Invalid 2FA code or backup code.' });
    }
    clearTotpFailures(user.id);
  }

  res.json(await createSession(user));
}));

app.get('/api/setup/2fa/generate', asyncRoute(async (req, res) => {
  const row = await get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) return res.status(403).json({ error: 'Initial setup already complete.' });

  // Use the username the operator typed on the setup screen if provided so
  // the authenticator app shows their actual handle, not the generic
  // "admin" placeholder. The user record itself doesn't exist yet, so we
  // accept the value via querystring without DB validation here.
  const requestedUsername = String(req.query.username || '').trim();
  const safeUsername = /^[A-Za-z0-9._-]{1,64}$/.test(requestedUsername) ? requestedUsername : 'admin';

  const secret = generateTotpSecret();
  const otpauthUrl = buildTotpKeyUri(safeUsername, 'Kept', secret);
  const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);

  res.json({ secret, qrCodeUrl });
}));

app.get('/api/auth/2fa/generate', requireAuth, asyncRoute(async (req, res) => {
  const secret = generateTotpSecret();
  const otpauthUrl = buildTotpKeyUri(req.user.username, 'Kept', secret);
  const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);

  res.json({ secret, qrCodeUrl });
}));

app.post('/api/auth/2fa/enable', requireAuth, asyncRoute(async (req, res) => {
  const { secret, token } = req.body;
  if (!secret || !token) return res.status(400).json({ error: 'Secret and token required.' });

  const isValid = verifyTotpToken(token, secret);
  if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code.' });

  const backupCodes = generateBackupCodes();
  await run('UPDATE users SET totpSecret = ?, totpEnabled = 1, totpBackupCodes = ? WHERE id = ?',
    [secret, JSON.stringify(backupCodes), req.user.id]);

  res.json({ success: true, backupCodes });
}));

app.delete('/api/auth/2fa/disable', requireAuth, asyncRoute(async (req, res) => {
  await run('UPDATE users SET totpSecret = NULL, totpEnabled = 0, totpBackupCodes = NULL WHERE id = ?', [req.user.id]);
  res.json({ success: true });
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => {
  await run('DELETE FROM sessions WHERE token = ?', [req.token]);
  res.status(204).end();
}));

app.patch('/api/users/me/preferences', requireAuth, asyncRoute(async (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  await run('UPDATE users SET theme = ? WHERE id = ?', [theme, req.user.id]);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
}));

// Marks the user as having had their starter/demo notes created. Idempotent —
// only sets the timestamp the first time. The client uses this server-side
// flag (instead of localStorage) so demos appear once across all devices and
// reliably even when first login goes through the 2FA path.
app.post('/api/users/me/mark-demo-notes-created', requireAuth, asyncRoute(async (req, res) => {
  if (!req.user.demoNotesCreatedAt) {
    await run('UPDATE users SET demoNotesCreatedAt = ? WHERE id = ?', [new Date().toISOString(), req.user.id]);
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
}));

app.patch('/api/users/me/profile', requireAuth, asyncRoute(async (req, res) => {
  const displayName = String(req.body.displayName || req.user.displayName).trim() || req.user.username;
  const avatarDataUrl = String(req.body.avatarDataUrl || '');
  const avatarPreset = req.body.avatarPreset ? String(req.body.avatarPreset) : req.user.avatarPreset;

  if (avatarDataUrl) {
    // Restrict to raster image data URLs. SVG can carry <script> and is
    // rendered to many places (sharing list, collaborator chips, navbar).
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarDataUrl)) {
      return res.status(400).json({ error: 'Avatar must be a PNG, JPEG, GIF, or WEBP data URL.' });
    }
  }
  if (avatarDataUrl.length > 5000000) {
    return res.status(400).json({ error: 'Avatar image is too large.' });
  }

  await run('UPDATE users SET displayName = ?, avatarDataUrl = ?, avatarPreset = ? WHERE id = ?', [displayName, avatarDataUrl, avatarPreset, req.user.id]);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  await broadcastProfileUpdate(user);
  res.json(publicUser(user));
}));

app.delete('/api/users/me', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const confirmation = String(req.body.confirmation || '');
  if (confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' });
  }
  if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const deletedUserId = req.user.id;
  await deleteUserAndOwnedData(deletedUserId);
  broadcastRealtime([deletedUserId], { type: 'account-deleted' });
  res.status(204).end();
}));

app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  const users = await all('SELECT * FROM users ORDER BY username');
  res.json(users.map(publicUser));
}));

app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const user = await createUser({ ...req.body, role });
  res.status(201).json(publicUser(user));
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  if (req.user.id === userId) return res.status(400).json({ error: 'You cannot delete your own account while signed in.' });

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (await isOriginalAdminUser(userId)) {
    return res.status(403).json({ error: 'The original administrator account cannot be deleted.' });
  }

  if (user.role === 'admin') {
    const admins = await get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
    if (admins.count <= 1) return res.status(400).json({ error: 'At least one administrator account is required.' });
  }

  await deleteUserAndOwnedData(userId);
  res.status(204).end();
}));

app.patch('/api/users/me/password', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const newSalt = randomHex(16);
  const newHash = hashPassword(newPassword, newSalt);
  await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, req.user.id]);
  // Invalidate all other sessions for this user
  await run('DELETE FROM sessions WHERE userId = ? AND token != ?', [req.user.id, req.token]);
  res.json({ success: true });
}));

app.patch('/api/users/:id/reset-password', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const newPassword = String(req.body.newPassword || '');

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const newSalt = randomHex(16);
  const newHash = hashPassword(newPassword, newSalt);
  await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, userId]);
  // Force the target user to re-authenticate everywhere
  await run('DELETE FROM sessions WHERE userId = ?', [userId]);
  closeRealtimeClientsForUser(userId, 'Password was reset.');
  res.json({ success: true });
}));

app.patch('/api/users/:id/toggle-enabled', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const enabled = req.body.enabled ? 1 : 0;

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (req.user.id === userId) return res.status(400).json({ error: 'You cannot disable your own account.' });

  await run('UPDATE users SET enabled = ? WHERE id = ?', [enabled, userId]);
  if (!enabled) {
    await run('DELETE FROM sessions WHERE userId = ?', [userId]);
    closeRealtimeClientsForUser(userId);
  }
  const updated = await get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json(publicUser(updated));
}));

app.get('/api/settings/registration', asyncRoute(async (_req, res) => {
  const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  const requireApproval = await getAppSetting('requireApproval', 'true');
  res.json({
    selfRegistrationEnabled: selfRegistrationEnabled === 'true',
    requireApproval: requireApproval === 'true'
  });
}));

app.patch('/api/settings/registration', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (req.body.selfRegistrationEnabled !== undefined) {
    await setAppSetting('selfRegistrationEnabled', String(!!req.body.selfRegistrationEnabled));
  }
  if (req.body.requireApproval !== undefined) {
    await setAppSetting('requireApproval', String(!!req.body.requireApproval));
  }
  const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  const requireApproval = await getAppSetting('requireApproval', 'true');
  res.json({
    selfRegistrationEnabled: selfRegistrationEnabled === 'true',
    requireApproval: requireApproval === 'true'
  });
}));

app.get('/api/admin/backup/status', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  const schedule = await getAppSetting('backupSchedule', 'none');
  const backupTime = await getAppSetting('backupTime', '03:00');
  const lastAutomatedAt = await getAppSetting('lastAutomatedBackupAt', null);
  const lastManualAt = await getAppSetting('lastManualBackupAt', null);
  const backupDir = path.join(dataDir, 'backups');
  const absolutePath = path.resolve(backupDir);
  let files = [];
  if (fs.existsSync(backupDir)) {
    files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sqlite'))
      .map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return { filename: f, size: stats.size, createdAt: stats.birthtime };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  res.json({ schedule, backupTime, lastAutomatedAt, lastManualAt, files, absolutePath });
}));


app.post('/api/admin/backup/schedule', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { schedule, backupTime } = req.body;
  if (schedule && !['none', 'daily', 'weekly', 'monthly'].includes(schedule)) {
    return res.status(400).json({ error: 'Invalid schedule.' });
  }
  if (schedule) await setAppSetting('backupSchedule', schedule);
  if (backupTime) await setAppSetting('backupTime', backupTime);
  res.json({ success: true, schedule, backupTime });
}));


app.post('/api/admin/backup/now', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  try {
    const filename = await performBackup(true);
    res.json({ success: true, filename });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
}));

app.post('/api/admin/users/:id/disable-2fa', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = parseInt(req.params.id);
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  await run('UPDATE users SET totpSecret = NULL, totpBackupCodes = NULL, totpEnabled = 0 WHERE id = ?', [userId]);
  res.json({ success: true, message: '2FA disabled for user.' });
}));

app.get('/api/admin/update-status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const trace = createPerfTrace('admin-update-status');
  const latest = getCachedLatestRelease();
  refreshLatestReleaseInBackground();
  trace.mark('cache');

  // Fetch any dismissals this admin has set for the current latest version.
  // A "forever" dismissal silences this version permanently for them; a
  // regular dismissal silences for 30 days.
  let dismissedUntil = null;
  let dismissedForever = false;
  if (latest?.version) {
    const dismissal = await get(
      'SELECT dismissedAt, forever FROM update_dismissals WHERE userId = ? AND version = ?',
      [req.user.id, latest.version]
    );
    trace.mark('dismissal-query', { latest: latest.version, hasDismissal: !!dismissal });
    if (dismissal) {
      dismissedForever = !!dismissal.forever;
      if (!dismissedForever && dismissal.dismissedAt) {
        const until = new Date(new Date(dismissal.dismissedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
        dismissedUntil = until.toISOString();
      }
    }
  } else {
    trace.mark('dismissal-query-skipped');
  }

  const isOutdated = latest?.version ? compareVersion(latest.version, KEPT_VERSION) > 0 : false;
  const now = new Date();
  const suppressed =
    dismissedForever ||
    (dismissedUntil && new Date(dismissedUntil) > now);

  sendJsonWithPerf(res, trace, {
    current: KEPT_VERSION,
    latest: latest?.version || null,
    releaseUrl: latest?.url || null,
    releaseNotes: latest?.notes || null,
    publishedAt: latest?.publishedAt || null,
    isOutdated,
    suppressed: !!suppressed,
    dismissedForever,
    dismissedUntil,
    checkedAt: updateCheckCache.fetchedAt ? new Date(updateCheckCache.fetchedAt).toISOString() : null,
    checkError: updateCheckCache.error
  });
}));

app.post('/api/admin/update-status/dismiss', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const version = String(req.body.version || '').trim().replace(/^v/i, '');
  if (!version) return res.status(400).json({ error: 'version is required.' });
  const forever = !!req.body.forever;
  await run(
    `INSERT INTO update_dismissals (userId, version, dismissedAt, forever)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, version) DO UPDATE SET dismissedAt = excluded.dismissedAt, forever = excluded.forever`,
    [req.user.id, version, new Date().toISOString(), forever ? 1 : 0]
  );
  res.status(204).end();
}));



function resolveBackupFilePath(filename) {
  // Reject any filename containing path separators or traversal segments
  // before path.join silently normalizes them out of the backup dir.
  if (typeof filename !== 'string') return null;
  if (!/^backup-[A-Za-z0-9._-]+\.sqlite$/.test(filename)) return null;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
  const backupDir = path.resolve(path.join(dataDir, 'backups'));
  const resolved = path.resolve(path.join(backupDir, filename));
  if (resolved !== path.join(backupDir, filename)) return null;
  if (!resolved.startsWith(backupDir + path.sep)) return null;
  return resolved;
}

app.get('/api/admin/backup/download/:filename', requireAuth, requireAdmin, (req, res) => {
  const filePath = resolveBackupFilePath(req.params.filename);
  if (!filePath) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath);
});

app.delete('/api/admin/backup/:filename', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const filePath = resolveBackupFilePath(req.params.filename);
  if (!filePath) return res.status(400).end();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  res.status(204).end();
}));

app.post('/api/auth/register', registerLimiter, asyncRoute(async (req, res) => {
  const regEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  if (regEnabled !== 'true') {
    return res.status(403).json({ error: 'Self-registration is not enabled.' });
  }

  const { username, displayName, email, password } = req.body;
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const requireApproval = await getAppSetting('requireApproval', 'true');
  const needsApproval = requireApproval === 'true';

  try {
    const user = await createUser({
      username,
      displayName,
      password,
      email,
      role: 'user',
      enabled: !needsApproval
    });
    res.status(201).json({
      success: true,
      needsApproval,
      message: needsApproval
        ? 'Account created. An administrator must approve your account before you can sign in.'
        : 'Account created successfully. You can now sign in.'
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    return res.status(e.status || 500).json({ error: e.message || 'Could not create account.' });
  }
}));

app.get('/api/sharing/users', requireAuth, asyncRoute(async (req, res) => {
  const users = await all(
    `SELECT users.id, users.username, users.displayName, users.avatarDataUrl, users.avatarPreset,
            COUNT(notes.id) AS shareCount
     FROM users
     LEFT JOIN note_collaborators ON note_collaborators.userId = users.id
     LEFT JOIN notes ON notes.id = note_collaborators.noteId AND notes.ownerUserId = ?
     WHERE users.id != ?
     GROUP BY users.id
     ORDER BY shareCount DESC, users.displayName COLLATE NOCASE, users.username COLLATE NOCASE`,
    [req.user.id, req.user.id]
  );
  res.json(users.map(u => ({
    ...publicCollaborator(u),
    online: realtimeClients.has(u.id)
  })));
}));

app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q.toLowerCase()}%`;
  const users = await all(
    `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
       AND (lower(username) LIKE ? OR lower(displayName) LIKE ? OR lower(COALESCE(email, '')) LIKE ?)
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 20`,
    [req.user.id, like, like, like]
  );
  res.json(users.map(publicCollaborator));
}));

app.get('/api/labels', requireAuth, asyncRoute(async (req, res) => {
  res.json(await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY id', [req.user.id]));
}));

app.post('/api/labels/find-or-create', requireAuth, asyncRoute(async (req, res) => {
  const label = await findOrCreateLabelForUser(req.user.id, req.body.name);
  res.status(200).json(label);
}));

app.post('/api/labels', requireAuth, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Label name is required.' });
  const result = await run('INSERT INTO labels (name, userId) VALUES (?, ?)', [name, req.user.id]);
  res.status(201).json({ id: result.id, name });
}));

app.patch('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Label name is required.' });
  const label = await get('SELECT id FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  if (!label) return res.status(404).json({ error: 'Label not found.' });
  await run('UPDATE labels SET name = ? WHERE id = ? AND userId = ?', [name, labelId, req.user.id]);
  res.json({ id: labelId, name });
}));

app.delete('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.id);
  const label = await get('SELECT id FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  if (!label) return res.status(404).json({ error: 'Label not found.' });
  await run('DELETE FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  res.status(204).end();
}));

app.post('/api/uploads/images', requireAuth, upload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required.' });
  await run(
    `INSERT INTO note_images (noteId, ownerUserId, storedFilename, originalName, fileSize, mimeType, uploadedAt)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      req.file.filename,
      req.file.originalname || req.file.filename,
      req.file.size,
      req.file.mimetype,
      new Date().toISOString()
    ]
  );
  res.status(201).json({
    url: `${PRIVATE_IMAGE_PREFIX}${req.file.filename}`,
    name: req.file.originalname || req.file.filename,
    size: req.file.size,
    type: req.file.mimetype
  });
}));

app.get('/api/uploads/images/:filename', requireAuthOrQueryToken, asyncRoute(async (req, res) => {
  const filename = safeStoredImageFilename(req.params.filename);
  if (!filename) return res.status(400).send('Invalid image filename.');

  const image = await get(
    `SELECT ni.*
     FROM note_images ni
     LEFT JOIN notes n ON n.id = ni.noteId
     LEFT JOIN note_collaborators nc ON nc.noteId = n.id AND nc.userId = ?
     WHERE ni.storedFilename = ?
       AND (
         (ni.noteId IS NULL AND ni.ownerUserId = ?)
         OR n.ownerUserId = ?
         OR nc.userId IS NOT NULL
       )
     LIMIT 1`,
    [req.user.id, filename, req.user.id, req.user.id]
  );
  if (!image) return res.status(404).send('Image not found.');

  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Image file not found.');

  res.setHeader('Content-Type', image.mimeType || imageMimeType(filename));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
}));

// ─── Attachment Endpoints ──────────────────────────────────────────────────

app.post('/api/notes/:noteId/attachments', requireAuth, uploadAttachment.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required.' });

  const noteId = Number(req.params.noteId);
  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) {
    fs.unlink(req.file.path, () => undefined);
    return res.status(404).json({ error: 'Note not found.' });
  }

  const now = new Date().toISOString();
  const result = await run(
    `INSERT INTO note_attachments (noteId, originalName, storedFilename, fileSize, mimeType, uploadedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      noteId,
      safeDownloadName(req.file.originalname || req.file.filename),
      req.file.filename,
      req.file.size,
      req.file.mimetype,
      now
    ]
  );

  res.status(201).json({
    id: result.id,
    originalName: safeDownloadName(req.file.originalname || req.file.filename),
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
    uploadedAt: now
  });
  await broadcastNoteChange(noteId, 'updated');
}));

app.get('/api/attachments/:attachmentId', requireAuth, asyncRoute(async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  const attachment = await get(
    `SELECT na.*, n.ownerUserId FROM note_attachments na
     JOIN notes n ON n.id = na.noteId
     LEFT JOIN note_collaborators nc ON nc.noteId = n.id AND nc.userId = ?
     WHERE na.id = ? AND (n.ownerUserId = ? OR nc.userId IS NOT NULL)`,
    [req.user.id, attachmentId, req.user.id]
  );

  if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

  const filePath = attachmentPath(attachment.storedFilename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });

  // Serve with Content-Disposition to force download and show original filename
  res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(attachment.originalName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
}));

app.delete('/api/notes/:noteId/attachments/:attachmentId', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.noteId);
  const attachmentId = Number(req.params.attachmentId);

  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  const attachment = await get(
    `SELECT na.* FROM note_attachments na
     WHERE na.id = ? AND na.noteId = ?`,
    [attachmentId, noteId]
  );

  if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

  // Only the note owner can delete attachments
  if (note.ownerUserId !== req.user.id) {
    return res.status(403).json({ error: 'Only the note owner can delete attachments.' });
  }

  // Delete file from disk
  const filePath = attachmentPath(attachment.storedFilename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Delete from database
  await run('DELETE FROM note_attachments WHERE id = ?', [attachmentId]);
  await broadcastNoteChange(noteId, 'updated');

  res.status(204).end();
}));


app.get('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const trace = req.query.view === 'card' ? createPerfTrace('notes-card', {
    view: req.query.view || '',
    limit: req.query.limit || '',
    cursor: !!req.query.cursor,
    q: !!req.query.q
  }) : null;
  scheduleTrashPurgeIfStale();
  trace?.mark('scheduled-trash-purge');

  if (req.query.view === 'card') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 200);
    const cursor = decodeNotesCursor(req.query.cursor);
    const searchTokens = searchTokensFromQuery(req.query.q);
    const searchWhere = noteSearchWhere(searchTokens);
    const whereClauses = [];
    const queryParams = [req.user.id, req.user.id, req.user.id, req.user.id];
    if (cursor) {
      whereClauses.push(`(
        userPinned < ?
        OR (userPinned = ? AND effectiveSortOrder < ?)
        OR (userPinned = ? AND effectiveSortOrder = ? AND id < ?)
      )`);
      queryParams.push(cursor.pinned, cursor.pinned, cursor.sortOrder, cursor.pinned, cursor.sortOrder, cursor.id);
    }
    if (searchWhere.clause) {
      whereClauses.push(searchWhere.clause);
      queryParams.push(...searchWhere.params);
    }
    const pageWhere = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    let page;
    let hasMore;
    if (!searchTokens.length) {
      const keyRows = await all(
        `WITH accessible_notes AS (
          SELECT notes.id,
                 COALESCE(
                   pos.sortOrder,
                   notes.sortOrder,
                   notes.id
                 ) AS effectiveSortOrder,
                 CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned
          FROM notes
          LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
          LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
          LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
          WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
        )
        SELECT * FROM accessible_notes
        ${pageWhere}
        ORDER BY userPinned DESC, effectiveSortOrder DESC, id DESC
        LIMIT ?`,
        [...queryParams, limit + 1]
      );
      trace.mark('key-query', { rows: keyRows.length, limit });
      const pageKeys = keyRows.slice(0, limit);
      hasMore = keyRows.length > limit;
      if (!pageKeys.length) return sendJsonWithPerf(res, trace, { notes: [], nextCursor: null });

      const pageIds = pageKeys.map(row => row.id);
      const idPlaceholders = pageIds.map(() => '?').join(',');
      const rows = await all(
        `SELECT notes.*,
                COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder,
                CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
                owner.displayName AS ownerDisplayName,
                owner.username AS ownerUsername,
                owner.avatarPreset AS ownerAvatarPreset,
                (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
                lastEditor.displayName AS lastEditorDisplayName,
                (SELECT COUNT(*) FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentCount,
                (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
         FROM notes
         LEFT JOIN users owner ON owner.id = notes.ownerUserId
         LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
         LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
         LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
         WHERE notes.id IN (${idPlaceholders})`,
        [req.user.id, req.user.id, ...pageIds]
      );
      trace.mark('detail-query', { rows: rows.length });
      const order = new Map(pageKeys.map((row, index) => [row.id, index]));
      page = rows.sort((a, b) => order.get(a.id) - order.get(b.id));
      trace.mark('detail-sort');
    } else {
      const rows = await all(
        `WITH accessible_notes AS (
          SELECT notes.*,
                 COALESCE(
                   pos.sortOrder,
                   notes.sortOrder,
                   notes.id
                 ) AS effectiveSortOrder,
                 CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
                 owner.displayName AS ownerDisplayName,
                 owner.username AS ownerUsername,
                 owner.avatarPreset AS ownerAvatarPreset,
                 (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
                 lastEditor.displayName AS lastEditorDisplayName,
                 (SELECT COUNT(*) FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentCount,
                 (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
          FROM notes
          LEFT JOIN users owner ON owner.id = notes.ownerUserId
          LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
          LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
          LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
          LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
          WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
        )
        SELECT * FROM accessible_notes
        ${pageWhere}
        ORDER BY userPinned DESC, effectiveSortOrder DESC, id DESC
        LIMIT ?`,
        [...queryParams, limit + 1]
      );
      trace.mark('search-query', { rows: rows.length, limit, tokens: searchTokens.length });
      page = rows.slice(0, limit);
      hasMore = rows.length > limit;
    }
    const me = req.user.id;
    const userIds = new Set();
    for (const row of page) {
      if (row.ownerUserId) userIds.add(row.ownerUserId);
      if (row.collaboratorIds) {
        for (const id of String(row.collaboratorIds).split(',')) {
          const n = Number(id);
          if (n) userIds.add(n);
        }
      }
    }
    let userMap = new Map();
    if (userIds.size) {
      const ids = Array.from(userIds);
      const placeholders = ids.map(() => '?').join(',');
      const userRows = await all(
        `SELECT id, username, displayName, avatarDataUrl, avatarPreset FROM users WHERE id IN (${placeholders})`,
        ids
      );
      userMap = new Map(userRows.map(u => [u.id, u]));
      trace.mark('user-query', { rows: userRows.length });
    } else {
      trace.mark('user-query-skipped');
    }
    const notes = page.map(row => {
      const owner = userMap.get(row.ownerUserId);
      if (owner) {
        row.ownerDisplayName = owner.displayName;
        row.ownerUsername = owner.username;
        row.ownerAvatarPreset = owner.avatarPreset || 'cat';
        row.ownerAvatarDataUrl = owner.id === me ? '' : (owner.avatarDataUrl || '');
      }
      const collabIds = row.collaboratorIds
        ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
        : [];
      row.collaborators = JSON.stringify(collabIds.map(id => {
        const u = userMap.get(id);
        if (!u) return null;
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarDataUrl: u.id === me ? '' : (u.avatarDataUrl || ''),
          avatarPreset: u.avatarPreset || 'cat',
          online: realtimeClients.has(u.id)
        };
      }).filter(Boolean));
      const note = dbNoteToCard(row, { includeSearchText: !!searchTokens.length });
      note.ownerOnline = realtimeClients.has(note.ownerUserId);
      note.collaborators = (note.collaborators || []).filter(Boolean).map(c => ({
        ...c,
        online: realtimeClients.has(c.id)
      }));
      if (note.ownerUserId === me) {
        note.ownerDisplayName = undefined;
        note.ownerUsername = undefined;
      }
      return note;
    });
    trace.mark('map-cards', { notes: notes.length });
    const attachmentNoteIds = notes.filter(note => note.hasAttachments).map(note => note.id);
    if (attachmentNoteIds.length) {
      const placeholders = attachmentNoteIds.map(() => '?').join(',');
      const attachmentRows = await all(
        `SELECT id, noteId, originalName, fileSize, mimeType, uploadedAt
         FROM note_attachments
         WHERE noteId IN (${placeholders})
         ORDER BY uploadedAt DESC`,
        attachmentNoteIds
      );
      trace.mark('attachment-query', { rows: attachmentRows.length, notes: attachmentNoteIds.length });
      const attachmentsByNoteId = new Map();
      for (const attachment of attachmentRows) {
        if (!attachmentsByNoteId.has(attachment.noteId)) {
          attachmentsByNoteId.set(attachment.noteId, []);
        }
        attachmentsByNoteId.get(attachment.noteId).push({
          id: attachment.id,
          originalName: attachment.originalName,
          fileSize: attachment.fileSize,
          mimeType: attachment.mimeType,
          uploadedAt: attachment.uploadedAt
        });
      }
      for (const note of notes) {
        const attachments = attachmentsByNoteId.get(note.id);
        if (!attachments) continue;
        note.attachments = attachments;
        note.hasAttachments = true;
        note.attachmentCount = attachments.length;
      }
    } else {
      trace.mark('attachment-query-skipped');
    }
    return sendJsonWithPerf(res, trace, { notes, nextCursor: hasMore ? encodeNotesCursor(page[page.length - 1]) : null });
  }

  // Avatars (data URLs) can be hundreds of KB each. Joining `owner.avatarDataUrl`
  // and per-collaborator avatars onto every note row produces a payload that
  // grows quadratically with note count × avatar size — easily 100 MB+ for a
  // user with hundreds of imported notes and a high-res avatar. Instead we
  // fetch avatars once per distinct user and let the client merge them in.
  const rows = await all(
    `SELECT notes.*,
            COALESCE(pos.sortOrder, notes.sortOrder) AS effectiveSortOrder,
            CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
            owner.displayName AS ownerDisplayName,
            owner.username AS ownerUsername,
            owner.avatarPreset AS ownerAvatarPreset,
            (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
            lastEditor.displayName AS lastEditorDisplayName
     FROM notes
     LEFT JOIN users owner ON owner.id = notes.ownerUserId
     LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
     LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
     LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
     LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
     WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
     ORDER BY effectiveSortOrder DESC, notes.id DESC`,
    [req.user.id, req.user.id, req.user.id, req.user.id]
  );

  // Collect every userId we'll need to resolve (owners + collaborators)
  // and fetch each user record once. This caps the avatar payload at
  // (number of distinct users) × (avatar size), independent of note count.
  const userIds = new Set();
  for (const row of rows) {
    if (row.ownerUserId) userIds.add(row.ownerUserId);
    if (row.collaboratorIds) {
      for (const id of String(row.collaboratorIds).split(',')) {
        const n = Number(id);
        if (n) userIds.add(n);
      }
    }
  }
  let userMap = new Map();
  if (userIds.size) {
    const ids = Array.from(userIds);
    const placeholders = ids.map(() => '?').join(',');
    const userRows = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset FROM users WHERE id IN (${placeholders})`,
      ids
    );
    userMap = new Map(userRows.map(u => [u.id, u]));
  }

  // Avatars are big (data-URL PNGs can be 600KB+). The previous version
  // duplicated the requesting user's own avatar onto every owned note,
  // exploding the response to 200MB+. The client already has its own
  // session avatar, so we only need to ship avatars for OTHER users
  // (shared-note owners and collaborators that aren't the requester).
  const me = req.user.id;

  // Fetch attachments for all notes
  const noteIds = rows.map(r => r.id);
  const attachmentsByNoteId = new Map();
  if (noteIds.length) {
    const placeholders = noteIds.map(() => '?').join(',');
    const attachments = await all(
      `SELECT id, noteId, originalName, fileSize, mimeType, uploadedAt FROM note_attachments WHERE noteId IN (${placeholders}) ORDER BY uploadedAt DESC`,
      noteIds
    );
    for (const att of attachments) {
      if (!attachmentsByNoteId.has(att.noteId)) {
        attachmentsByNoteId.set(att.noteId, []);
      }
      attachmentsByNoteId.get(att.noteId).push({
        id: att.id,
        originalName: att.originalName,
        fileSize: att.fileSize,
        mimeType: att.mimeType,
        uploadedAt: att.uploadedAt
      });
    }
  }

  res.json(rows.map(row => {
    const owner = userMap.get(row.ownerUserId);
    if (owner && owner.id !== me) {
      row.ownerAvatarDataUrl = owner.avatarDataUrl || '';
    } else {
      row.ownerAvatarDataUrl = '';
    }

    const collabIds = row.collaboratorIds
      ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
      : [];
    row.collaborators = JSON.stringify(collabIds.map(id => {
      const u = userMap.get(id);
      if (!u) return null;
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        // Skip the avatar payload for the requester themselves; the
        // client already has it from the session.
        avatarDataUrl: u.id === me ? '' : (u.avatarDataUrl || ''),
        avatarPreset: u.avatarPreset || 'cat'
      };
    }).filter(Boolean));

    const note = dbNoteToApi(row);
    note.attachments = attachmentsByNoteId.get(row.id) || [];
    note.ownerOnline = realtimeClients.has(note.ownerUserId);
    note.collaborators = note.collaborators.filter(Boolean).map(c => ({
      ...c,
      online: realtimeClients.has(c.id)
    }));
    return note;
  }));
}));

app.get('/api/notes/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(await accessibleNoteSummaries(req.user.id, { query: q, limit: 20 }));
}));

app.get('/api/ai/context', requireAuth, asyncRoute(async (req, res) => {
  const query = String(req.query.query || req.query.q || '').trim();
  const labels = await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY name COLLATE NOCASE', [req.user.id]);
  const users = await all(
    `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 50`,
    [req.user.id]
  );
  const recentNotes = await accessibleNoteSummaries(req.user.id, { limit: 20 });
  let candidateNotes = query
    ? await accessibleNoteSummaries(req.user.id, { query, limit: 20 })
    : recentNotes;
  if (!candidateNotes.length) candidateNotes = recentNotes;

  let currentOpenNote = null;
  const currentOpenNoteId = Number(req.query.currentOpenNoteId || 0);
  if (currentOpenNoteId) {
    const rows = await accessibleNoteSummaryRows(req.user.id, { noteId: currentOpenNoteId, limit: 1 });
    currentOpenNote = rows[0] ? noteSummaryFromRow(rows[0]) : null;
  }

  res.json({
    currentUser: publicUser(req.user),
    labels,
    users: users.map(publicCollaborator),
    recentNotes,
    candidateNotes,
    currentOpenNote
  });
}));

app.post('/api/ai/action-plan/validate', requireAuth, asyncRoute(async (req, res) => {
  const transcript = String(req.body.transcript || '');
  const actionPlan = req.body.actionPlan;
  const validation = await validateKeptActionPlan(req.user.id, transcript, actionPlan);
  await insertAiActionHistory(
    req.user.id,
    transcript,
    actionPlan,
    validation.normalizedPlan,
    validation.valid ? 'validated' : 'failed'
  );
  res.json(validation);
}));

app.post('/api/ai/action-plan/execute', requireAuth, asyncRoute(async (req, res) => {
  const transcript = String(req.body.transcript || '');
  const actionPlan = req.body.actionPlan;
  const executeOptions = req.body.executeOptions || req.body.options || {};
  const validation = await validateKeptActionPlan(req.user.id, transcript, actionPlan);
  if (!validation.valid) {
    await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
    return res.status(400).json({ ok: false, errors: validation.errors, validation });
  }
  if (validation.requiresConfirmation && executeOptions.confirmed !== true) {
    await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
    return res.status(409).json({
      ok: false,
      errors: ['This action plan requires confirmation before execution.'],
      requiresConfirmation: true,
      normalizedPlan: validation.normalizedPlan
    });
  }

  const allowPartial = !!executeOptions.allowPartial;
  const selected = Array.isArray(executeOptions.selectedActionIndexes)
    ? new Set(executeOptions.selectedActionIndexes.map(Number).filter(Number.isInteger))
    : null;
  const actions = selectedActionsWithDependencies(validation.normalizedPlan.actions, selected);
  const state = {
    createdNoteIds: [],
    updatedNoteIds: new Set(),
    createdLabelIds: new Set(),
    reminderIds: [],
    remindersToSync: [],
    shareBroadcasts: [],
    lastCreatedNoteId: null
  };
  const executed = [];
  const failed = [];

  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      try {
        const result = await executeSmartAction(req.user.id, action, state);
        executed.push({ index, ...result });
      } catch (error) {
        failed.push({ index, type: action.type, error: error.message || 'Action failed.' });
        if (!allowPartial) throw error;
      }
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    await insertAiActionHistory(req.user.id, transcript, actionPlan, { executed, failed }, 'failed');
    return res.status(400).json({
      ok: false,
      executed: [],
      failed: failed.length ? failed : [{ error: error.message || 'Execution failed.' }],
      createdNoteIds: [],
      updatedNoteIds: [],
      createdLabelIds: [],
      reminderIds: []
    });
  }

  const status = failed.length ? 'partial' : 'success';
  const response = {
    ok: failed.length === 0,
    executed,
    failed,
    createdNoteIds: state.createdNoteIds,
    updatedNoteIds: Array.from(state.updatedNoteIds),
    createdLabelIds: Array.from(state.createdLabelIds),
    reminderIds: state.reminderIds
  };
  await insertAiActionHistory(req.user.id, transcript, actionPlan, response, status);

  for (const noteId of state.createdNoteIds) await broadcastNoteChange(noteId, 'created', [req.user.id]);
  for (const noteId of state.updatedNoteIds) await broadcastNoteChange(noteId, 'updated');
  for (const share of state.shareBroadcasts) await broadcastNoteChange(share.noteId, 'collaborators-updated', share.previousRecipients);
  if (state.createdLabelIds.size) await cleanupUnusedLabels(req.user.id);
  await syncSmartReminderIntegrations(req.user.id, state.remindersToSync);

  res.status(failed.length ? 207 : 200).json(response);
}));

app.post('/api/ai/notes/:id/archive', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
  try {
    const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: true, trashed: false });
    await broadcastNoteChange(noteId, 'updated');
    res.json({ ok: true, ...status });
  } catch (error) {
    if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
    throw error;
  }
}));

app.post('/api/ai/notes/:id/trash', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
  try {
    const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: false, trashed: true });
    await broadcastNoteChange(noteId, 'updated');
    res.json({ ok: true, ...status });
  } catch (error) {
    if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
    throw error;
  }
}));

app.get('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const row = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Note not found.' });
  const note = dbNoteToApi(row);

  // Fetch attachments for this note
  const attachments = await all(
    `SELECT id, originalName, fileSize, mimeType, uploadedAt FROM note_attachments WHERE noteId = ? ORDER BY uploadedAt DESC`,
    [note.id]
  );
  note.attachments = attachments.map(att => ({
    id: att.id,
    originalName: att.originalName,
    fileSize: att.fileSize,
    mimeType: att.mimeType,
    uploadedAt: att.uploadedAt
  }));
  note.hasAttachments = note.attachments.length > 0;
  note.attachmentCount = note.attachments.length;
  note.collaborators = await getCollaboratorsForNote(note.id);
  note.ownerOnline = realtimeClients.has(note.ownerUserId);

  res.json(note);
}));

app.get('/api/notes/:id/collaborators', requireAuth, asyncRoute(async (req, res) => {
  const note = await getOwnedNote(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  res.json(await getCollaboratorsForNote(Number(req.params.id)));
}));

app.put('/api/notes/:id/collaborators', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getOwnedNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  const previousRecipients = await getNoteRecipientIds(noteId);
  const previousCollaborators = await all('SELECT userId FROM note_collaborators WHERE noteId = ?', [noteId]);

  const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
  const nextSet = new Set(userIds.filter(userId => userId !== req.user.id));
  await run('DELETE FROM note_collaborators WHERE noteId = ?', [noteId]);
  for (const userId of nextSet) {
    const exists = await get('SELECT id FROM users WHERE id = ?', [userId]);
    if (exists) {
      await run(
        'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)',
        [noteId, userId, new Date().toISOString()]
      );
    }
  }
  // Track removed collaborators so they can be re-added via the rejoin endpoint
  // (the snackbar undo flow). Without a grant, rejoin would let any user attach
  // themselves to any note id.
  const grantedAt = new Date().toISOString();
  for (const row of previousCollaborators) {
    if (!nextSet.has(row.userId)) {
      await run(
        'INSERT OR REPLACE INTO note_collaborator_rejoin_grants (noteId, userId, grantedAt) VALUES (?, ?, ?)',
        [noteId, row.userId, grantedAt]
      );
    }
  }

  const collaborators = await getCollaboratorsForNote(noteId);
  const nextRecipients = await getNoteRecipientIds(noteId);
  await broadcastNoteChange(noteId, 'collaborators-updated', [...previousRecipients, ...nextRecipients]);
  res.json(collaborators);
}));

app.post('/api/notes/:id/collaborators/rejoin', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await get('SELECT id FROM notes WHERE id = ?', [noteId]);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  // Only allow rejoin if this user was recently a collaborator on this note
  // (granted at self-removal or owner-removal). Without this check any
  // authenticated user could attach themselves to any note id.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const grant = await get(
    'SELECT noteId FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId = ? AND grantedAt >= ?',
    [noteId, req.user.id, cutoff]
  );
  if (!grant) return res.status(403).json({ error: 'Rejoin not permitted.' });

  await run(
    'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)',
    [noteId, req.user.id, new Date().toISOString()]
  );
  await run('DELETE FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId = ?', [noteId, req.user.id]);
  await broadcastNoteChange(noteId, 'collaborators-updated');
  res.status(204).end();
}));

app.patch('/api/notes/reorder', requireAuth, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No note ids provided.' });

  const accessibleRows = await all(
    `SELECT notes.id FROM notes
     LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
     WHERE (notes.ownerUserId = ? OR access.userId IS NOT NULL)
     AND notes.id IN (${ids.map(() => '?').join(',')})`,
    [req.user.id, req.user.id, ...ids]
  );
  const accessibleIds = new Set(accessibleRows.map(row => row.id));
  const orderedIds = ids.filter(id => accessibleIds.has(id));
  if (!orderedIds.length) return res.status(204).end();

  const base = Date.now();
  for (let index = 0; index < orderedIds.length; index += 1) {
    const sortOrder = base + (orderedIds.length - index);
    try {
      await run(
        'INSERT OR REPLACE INTO user_note_positions (userId, noteId, sortOrder) VALUES (?, ?, ?)',
        [req.user.id, orderedIds[index], sortOrder]
      );
    } catch (err) {
      console.error(`Failed to update position for note ${orderedIds[index]}:`, err);
    }
  }
  broadcastRealtime([req.user.id], { type: 'notes-changed', action: 'reordered' });
  res.status(204).end();
}));

app.post('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const noteData = canonicalizeNotePayload(req.body);
  const now = new Date().toISOString();
  const trashedAt = noteData.trashed ? now : null;
  const result = await run(
    `INSERT INTO notes
     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      String(noteData.noteTitle || ''),
      noteData.noteBody || '',
      noteData.bgColor || '',
      noteData.bgImage || '',
      JSON.stringify(noteData.checkBoxes || []),
      JSON.stringify(noteData.images || []),
      noteData.isCbox ? 1 : 0,
      JSON.stringify(noteData.labels || []),
      noteData.archived ? 1 : 0,
      noteData.trashed ? 1 : 0,
      trashedAt,
      Date.now(),
      now,
      now,
      req.user.id,
      noteData.isDemo ? 1 : 0
    ]
  );
  await syncNoteImagesForNote(result.id, req.user.id, noteData);
  if (noteData.pinned) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, result.id]);
  }
  await broadcastNoteChange(result.id, 'created', [req.user.id]);
  res.status(201).json({ id: result.id });
}));

app.put('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const note = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  const isOwner = note.ownerUserId === req.user.id;
  const next = canonicalizeNotePayload({ ...dbNoteToApi(note), ...req.body });
  if (!isOwner) {
    next.bgColor = note.bgColor || '';
    next.bgImage = note.bgImage || '';
    next.labels = parseJson(note.labels, []);
    next.archived = Boolean(note.archived);
    next.trashed = Boolean(note.trashed);
    next.pinned = Boolean(note.pinned);
    next.isCbox = Boolean(note.isCbox);
  }
  const trashedAt = nextTrashedAt(note, next);
  await run(
    `UPDATE notes SET
      noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?,
      checkBoxes = ?, images = ?, isCbox = ?, labels = ?, archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?
     WHERE id = ?`,
    [
      String(next.noteTitle || ''),
      next.noteBody || '',
      next.bgColor || '',
      next.bgImage || '',
      JSON.stringify(next.checkBoxes || []),
      JSON.stringify(next.images || []),
      next.isCbox ? 1 : 0,
      JSON.stringify(next.labels || []),
      next.archived ? 1 : 0,
      next.trashed ? 1 : 0,
      trashedAt,
      new Date().toISOString(),
      req.user.id,
      next.isDemo ? 1 : 0,
      Number(req.params.id)
    ]
  );
  const shouldPin = isOwner ? !!next.pinned : !!note.pinned;
  if (shouldPin) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, Number(req.params.id)]);
  } else {
    await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [req.user.id, Number(req.params.id)]);
  }
  await syncNoteImagesForNote(Number(req.params.id), note.ownerUserId, next);
  await broadcastNoteChange(Number(req.params.id), 'updated');
  await cleanupUnusedLabels(req.user.id);
  res.status(204).end();
}));

app.patch('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const existing = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!existing) return res.status(404).json({ error: 'Note not found.' });

  const isOwner = existing.ownerUserId === req.user.id;
  const next = canonicalizeNotePayload({ ...dbNoteToApi(existing), ...req.body });
  if (!isOwner) {
    next.bgColor = existing.bgColor || '';
    next.bgImage = existing.bgImage || '';
    next.labels = parseJson(existing.labels, []);
    next.archived = Boolean(existing.archived);
    next.trashed = Boolean(existing.trashed);
    next.pinned = Boolean(existing.pinned);
    next.isCbox = Boolean(existing.isCbox);
  }
  const trashedAt = nextTrashedAt(existing, next);
  await run(
    `UPDATE notes SET
      noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?,
      checkBoxes = ?, images = ?, isCbox = ?, labels = ?, archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?
     WHERE id = ?`,
    [
      String(next.noteTitle || ''),
      next.noteBody || '',
      next.bgColor || '',
      next.bgImage || '',
      JSON.stringify(next.checkBoxes || []),
      JSON.stringify(next.images || []),
      next.isCbox ? 1 : 0,
      JSON.stringify(next.labels || []),
      next.archived ? 1 : 0,
      next.trashed ? 1 : 0,
      trashedAt,
      new Date().toISOString(),
      req.user.id,
      next.isDemo ? 1 : 0,
      Number(req.params.id)
    ]
  );
  const shouldPin = isOwner ? !!next.pinned : !!existing.pinned;
  if (shouldPin) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, Number(req.params.id)]);
  } else {
    await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [req.user.id, Number(req.params.id)]);
  }
  await syncNoteImagesForNote(Number(req.params.id), existing.ownerUserId, next);
  await broadcastNoteChange(Number(req.params.id), 'updated');
  await cleanupUnusedLabels(req.user.id);
  res.status(204).end();
}));

app.post('/api/notes/:id/clone', requireAuth, asyncRoute(async (req, res) => {
  const row = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Note not found.' });

  const now = new Date().toISOString();
  const note = dbNoteToApi(row);
  const result = await run(
    `INSERT INTO notes
     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, isDemo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      String(note.noteTitle || ''),
      note.noteBody || '',
      note.bgColor || '',
      note.bgImage || '',
      JSON.stringify(note.checkBoxes || []),
      JSON.stringify(note.images || []),
      note.isCbox ? 1 : 0,
      JSON.stringify(note.labels || []),
      note.archived ? 1 : 0,
      note.trashed ? 1 : 0,
      note.trashed ? now : null,
      Date.now(),
      now,
      now,
      note.isDemo ? 1 : 0
    ]
  );
  if (note.pinned) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, result.id]);
  }
  await syncNoteImagesForNote(result.id, req.user.id, note);
  await broadcastNoteChange(result.id, 'created', [req.user.id]);
  res.status(201).json({ id: result.id });
}));

app.post('/api/notes/merge', requireAuth, asyncRoute(async (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds)
    ? req.body.orderedIds.map(Number).filter(Boolean)
    : [];
  if (orderedIds.length < 2) return res.status(400).json({ error: 'At least two notes are required to merge.' });

  // Owned-only. Refuse if any source isn't owned by the requester (we don't
  // want to trash someone else's shared note as a side effect of merge).
  const placeholders = orderedIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT * FROM notes WHERE id IN (${placeholders}) AND ownerUserId = ?`,
    [...orderedIds, req.user.id]
  );
  if (rows.length !== orderedIds.length) {
    return res.status(403).json({ error: 'You can only merge notes you own.' });
  }
  // Re-order rows to match the user's chosen merge order.
  const byId = new Map(rows.map(r => [r.id, r]));
  const sources = orderedIds.map(id => byId.get(id));
  if (sources.some(s => !s)) return res.status(404).json({ error: 'One or more notes were not found.' });

  // Build the merged note. Hybrid: keep text body AND the checklist as
  // first-class fields so the editor can render both stacked. Drawings get
  // flattened to plain inline images (id !== 'drawing') in the merged note.
  const apiNotes = sources.map(dbNoteToApi);

  const mergedTitle = apiNotes.find(n => n.noteTitle && n.noteTitle.trim())?.noteTitle || '';
  const mergedBgColor = apiNotes.find(n => n.bgColor)?.bgColor || '';
  // Treat empty `url("")` as "no image" — older note saves stored it as that
  // literal CSS value when no background was set, and propagating it would
  // make the merged note think it has a real bgImage and apply the .detail-bg
  // class (which forces a white background).
  const hasRealBgImage = (v) => !!v && v !== 'url("")' && v !== 'url()';
  const mergedBgImage = apiNotes.find(n => hasRealBgImage(n.bgImage))?.bgImage || '';

  const bodyParts = [];
  const mergedCheckBoxes = [];
  const mergedImages = [];
  const labelMap = new Map();

  for (const note of apiNotes) {
    if (note.noteBody && note.noteBody.trim()) bodyParts.push(note.noteBody);
    for (const cb of (note.checkBoxes || [])) mergedCheckBoxes.push(cb);
    for (const img of (note.images || [])) {
      // Flatten drawings — strip the editor-marker id so it loads as a
      // regular inline image. The original drawing note remains in trash and
      // is still editable as a drawing if restored.
      const flattened = img.id === 'drawing'
        ? { ...img, id: `drawing-flat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: (img.name || '').replace(/^Drawing\|/, '') }
        : img;
      mergedImages.push(flattened);
    }
    for (const label of (note.labels || [])) {
      if (label.id && !labelMap.has(label.id)) labelMap.set(label.id, label);
    }
  }
  const mergedBody = bodyParts.join('<br><br>');
  const mergedLabels = Array.from(labelMap.values());
  // isCbox=true so the editor's checklist surface activates; the new editor
  // logic will additionally render the body when both are present.
  const isCbox = mergedCheckBoxes.length > 0 ? 1 : 0;

  const now = new Date().toISOString();
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await run(
      `INSERT INTO notes
       (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, 0)`,
      [
        req.user.id,
        String(mergedTitle || ''),
        mergedBody,
        mergedBgColor,
        mergedBgImage,
        JSON.stringify(mergedCheckBoxes),
        JSON.stringify(mergedImages),
        isCbox,
        JSON.stringify(mergedLabels),
        Date.now(),
        now,
        now,
        req.user.id
      ]
    );
    const newNoteId = result.id;
    await syncNoteImagesForNote(newNoteId, req.user.id, { noteBody: mergedBody, images: mergedImages });

    // Re-parent attachments from sources onto the merged note. This avoids
    // re-uploading files and keeps the storedFilename references intact.
    await run(
      `UPDATE note_attachments SET noteId = ? WHERE noteId IN (${placeholders})`,
      [newNoteId, ...orderedIds]
    );

    // Re-parent the earliest pending reminder so it fires against the merged
    // note; delete any other pending reminders from the source notes. The
    // editor UI assumes one reminder per note (single chip, single remove
    // action), so dragging multiple reminders onto the merged note would
    // create "invisible" reminders the user can't see or cancel. We pick
    // the earliest pending one (the most conservative — it fires first)
    // and discard the rest. Non-pending reminders (fired/dismissed/snoozed)
    // are historical and stay with the trashed source notes (cascade-purge
    // when trash expires).
    const pendingReminders = await all(
      `SELECT id, dueAtUtc FROM reminders
       WHERE userId = ? AND status = 'pending' AND noteId IN (${placeholders})
       ORDER BY dueAtUtc ASC`,
      [req.user.id, ...orderedIds]
    );
    if (pendingReminders.length > 0) {
      const keepId = pendingReminders[0].id;
      await run(
        `UPDATE reminders SET noteId = ?, updatedAt = ? WHERE id = ?`,
        [newNoteId, now, keepId]
      );
      if (pendingReminders.length > 1) {
        const drop = pendingReminders.slice(1);
        // Fetch full rows so the external-calendar cleanup has gcalEventId etc.
        const dropPlaceholders = drop.map(() => '?').join(',');
        const dropFull = await all(
          `SELECT * FROM reminders WHERE id IN (${dropPlaceholders})`,
          drop.map(r => r.id)
        );
        await run(
          `DELETE FROM reminders WHERE id IN (${dropPlaceholders})`,
          drop.map(r => r.id)
        );
        // Best-effort cleanup of any externally-synced calendar entries.
        // Failures are logged but don't block the merge — the reminder is
        // already gone from our DB and orphaning a remote event is recoverable.
        const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
        for (const r of dropFull) {
          if (caldav) {
            deleteReminderFromCaldav(caldav, r.id).catch(err => console.error('CalDAV delete failed during merge:', err.message));
          }
          gcalDeleteReminder(req.user.id, r).catch(err => console.error('GCal delete failed during merge:', err.message));
        }
      }
    }

    // Trash the source notes (10-day auto-purge as usual).
    await run(
      `UPDATE notes SET trashed = 1, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id IN (${placeholders})`,
      [now, now, req.user.id, ...orderedIds]
    );
    // Drop pin state for the trashed sources (per-user pin records).
    await run(
      `DELETE FROM user_pins WHERE userId = ? AND noteId IN (${placeholders})`,
      [req.user.id, ...orderedIds]
    );

    await run('COMMIT');

    const recipients = new Set([req.user.id]);
    for (const id of orderedIds) {
      const r = await getNoteRecipientIds(id);
      r.forEach(uid => recipients.add(uid));
    }
    await broadcastNoteChange(newNoteId, 'created', [req.user.id]);
    for (const id of orderedIds) {
      await broadcastNoteChange(id, 'updated', Array.from(recipients));
    }

    res.status(201).json({ id: newNoteId });
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}));

app.patch('/api/notes/labels/:labelId', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.labelId);
  const labelValue = String(req.body.name || '');
  const rows = await all('SELECT id, labels FROM notes WHERE ownerUserId = ?', [req.user.id]);
  const recipientIds = new Set([req.user.id]);

  for (const row of rows) {
    let labels = parseJson(row.labels, []);
    if (labelValue === '') {
      labels = labels.filter(label => label.id !== labelId);
    } else {
      labels = labels.map(label => label.id === labelId ? { ...label, name: labelValue } : label);
    }
    await run('UPDATE notes SET labels = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(labels), new Date().toISOString(), row.id]);
    const noteRecipients = await getNoteRecipientIds(row.id);
    noteRecipients.forEach(userId => recipientIds.add(userId));
  }

  broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
  await cleanupUnusedLabels(req.user.id);
  res.status(204).end();
}));

app.delete('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  const isOwner = note.ownerUserId === req.user.id;
  if (isOwner) {
    const recipients = await getNoteRecipientIds(noteId);
    await deleteAttachmentFilesForNote(noteId);
    await deleteImageFilesForNote(noteId);
    await run('DELETE FROM notes WHERE id = ?', [noteId]);
    await broadcastNoteChange(noteId, 'deleted', recipients);
  } else {
    // If not owner, just remove self as collaborator (unshare).
    // Grant a rejoin token so the snackbar undo flow can re-add them.
    await run('DELETE FROM note_collaborators WHERE noteId = ? AND userId = ?', [noteId, req.user.id]);
    await run(
      'INSERT OR REPLACE INTO note_collaborator_rejoin_grants (noteId, userId, grantedAt) VALUES (?, ?, ?)',
      [noteId, req.user.id, new Date().toISOString()]
    );
    await broadcastNoteChange(noteId, 'updated');
  }
  await cleanupUnusedLabels(req.user.id);
  res.status(204).end();
}));

// ─── Reminder routes ───────────────────────────────────────────────────────

async function reminderNoteMap(reminders) {
  const noteIds = [...new Set((reminders || []).map(reminder => Number(reminder.noteId || 0)).filter(Boolean))];
  if (!noteIds.length) return new Map();
  const placeholders = noteIds.map(() => '?').join(',');
  const notes = await all(
    `SELECT id, noteTitle, noteBody FROM notes WHERE id IN (${placeholders})`,
    noteIds
  );
  return new Map(notes.map(note => [Number(note.id), note]));
}

function reminderResponse(reminder, notesById = new Map()) {
  const noteId = Number(reminder.noteId || 0) || null;
  const note = noteId ? notesById.get(noteId) : null;
  const explicitTitle = plainText(reminder.title || '');
  const explicitBody = plainText(reminder.body || '');
  const noteTitle = plainText(note?.noteTitle || '');
  const noteBody = plainText(note?.noteBody || '').slice(0, 500);
  return {
    ...reminder,
    title: explicitTitle || noteTitle || null,
    body: explicitBody || noteBody || null,
    deepLink: noteId ? `kept://note/${noteId}` : null
  };
}

async function enrichReminderResponses(reminders) {
  const notesById = await reminderNoteMap(reminders);
  return reminders.map(reminder => reminderResponse(reminder, notesById));
}

async function enrichReminderResponse(reminder) {
  return (await enrichReminderResponses([reminder]))[0];
}

const visibleReminderJoin = 'LEFT JOIN notes reminder_notes ON reminder_notes.id = reminders.noteId';
const visibleReminderWhere = '(reminders.noteId IS NULL OR (COALESCE(reminder_notes.archived, 0) = 0 AND COALESCE(reminder_notes.trashed, 0) = 0))';

app.get('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [req.user.id]
  );
  res.json(await enrichReminderResponses(reminders));
}));

// ─── ICS feed routes ───────────────────────────────────────────────────────

app.get('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
  const token = await getOrCreateIcsFeedToken(req.user.id);
  res.json({ token });
}));

app.post('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
  const token = randomHex(20);
  await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, req.user.id]);
  res.json({ token });
}));

// Shared handler for both ICS feed URL shapes. The "trailing filename"
// variant exists because Thunderbird (and a few other clients) names a
// subscribed calendar after the last URL path segment — putting the token
// at the end means users see the token as the default calendar name.
// Putting kept-reminders.ics at the end gives them a friendly default.
const handleIcsFeed = asyncRoute(async (req, res) => {
  const user = await get('SELECT id FROM users WHERE icsFeedToken = ?', [req.params.token]);
  if (!user) return res.status(404).type('text').send('Feed not found.');
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [user.id]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="kept-reminders.ics"',
    'Cache-Control': 'no-cache, no-store'
  });
  res.send(buildIcsFeed(enrichedReminders));
});

// Friendly route: token in the middle, kept-reminders.ics at the end so
// calendar clients pick up a sensible default name from the URL path.
app.get('/api/reminders/ics/:token/kept-reminders.ics', handleIcsFeed);
// Legacy route kept so existing subscriptions don't break.
app.get('/api/reminders/ics/:token', handleIcsFeed);

app.post('/api/reminders/import', requireAuth, asyncRoute(async (req, res) => {
  const icsContent = String(req.body.icsContent || '');
  if (!icsContent) return res.status(400).json({ error: 'icsContent is required.' });
  const events = parseIcsContent(icsContent);
  const now = new Date().toISOString();
  let imported = 0;
  for (const event of events) {
    if (!event.dtstart) continue;
    try {
      const dueAt = parseIcalDate(event.dtstart);
      if (isNaN(dueAt.getTime())) continue;
      await run(
        `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, status, title, body, createdAt, updatedAt)
         VALUES (NULL, ?, ?, 'UTC', 'pending', ?, ?, ?, ?)`,
        [req.user.id, dueAt.toISOString(), plainText(event.summary) || null, plainText(event.description) || null, now, now]
      );
      imported++;
    } catch {}
  }
  res.json({ imported });
}));

app.get('/api/push/vapid-public-key', requireAuth, (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }

  const now = new Date().toISOString();
  await run(
    `INSERT INTO push_subscriptions (userId, endpoint, subscription, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET userId = excluded.userId, subscription = excluded.subscription, updatedAt = excluded.updatedAt`,
    [req.user.id, subscription.endpoint, JSON.stringify(subscription), now, now]
  );
  res.status(201).json({ ok: true });
}));

app.delete('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  if (endpoint) {
    await run('DELETE FROM push_subscriptions WHERE userId = ? AND endpoint = ?', [req.user.id, endpoint]);
  }
  res.status(204).end();
}));

app.post('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
  const { noteId, dueAtUtc, timezone, title, body, imageUrl, repeatRule } = req.body;
  if (!dueAtUtc) return res.status(400).json({ error: 'dueAtUtc is required.' });
  if (noteId) {
    const note = await getAccessibleNote(Number(noteId), req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found.' });
  }
  const now = new Date().toISOString();
  const result = await run(
    `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [noteId || null, req.user.id, String(dueAtUtc), String(timezone || 'UTC'), repeatRule || null,
     plainText(title) || null, plainText(body) || null, String(imageUrl || '') || null, now, now]
  );
  const reminder = await get('SELECT * FROM reminders WHERE id = ?', [result.id]);
  const enrichedReminder = await enrichReminderResponse(reminder);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
  if (caldav) pushReminderToCaldav(caldav, enrichedReminder).catch(err => console.error('CalDAV push failed:', err.message));
  gcalPushReminder(req.user.id, enrichedReminder).catch(err => console.error('GCal push failed:', err.message));
  res.status(201).json(enrichedReminder);
}));

app.patch('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  const now = new Date().toISOString();
  const validStatuses = ['pending','fired','dismissed','snoozed'];
  const status = validStatuses.includes(req.body.status) ? req.body.status : reminder.status;
  const dueAtUtc = req.body.dueAtUtc || reminder.dueAtUtc;
  await run(`UPDATE reminders SET status = ?, dueAtUtc = ?, updatedAt = ? WHERE id = ?`, [status, dueAtUtc, now, reminder.id]);
  const updated = await get('SELECT * FROM reminders WHERE id = ?', [reminder.id]);
  const enrichedUpdated = await enrichReminderResponse(updated);
  if (status === 'pending') {
    const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
    if (caldav) pushReminderToCaldav(caldav, enrichedUpdated).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(req.user.id, enrichedUpdated).catch(err => console.error('GCal push failed:', err.message));
  }
  res.json(enrichedUpdated);
}));

app.delete('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  await run('DELETE FROM reminders WHERE id = ?', [reminder.id]);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
  if (caldav) deleteReminderFromCaldav(caldav, reminder.id).catch(err => console.error('CalDAV delete failed:', err.message));
  gcalDeleteReminder(req.user.id, reminder).catch(err => console.error('GCal delete failed:', err.message));
  res.status(204).end();
}));

// ─── CalDAV settings routes ────────────────────────────────────────────────

app.get('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
  if (!s) return res.json(null);
  res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
}));

app.put('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  const { serverUrl, calendarUrl, username, password, enabled } = req.body;
  if (!calendarUrl || !username || !password) {
    return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
  }
  const now = new Date().toISOString();
  const existing = await get('SELECT userId FROM caldav_settings WHERE userId = ?', [req.user.id]);
  const isPlaceholder = password === '••••••••';
  if (existing) {
    if (isPlaceholder) {
      await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, enabled=?, updatedAt=? WHERE userId=?`,
        [serverUrl || calendarUrl, calendarUrl, username, enabled ? 1 : 0, now, req.user.id]);
    } else {
      await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, password=?, enabled=?, updatedAt=? WHERE userId=?`,
        [serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, req.user.id]);
    }
  } else {
    await run(`INSERT INTO caldav_settings (userId, serverUrl, calendarUrl, username, password, enabled, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.id, serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, now]);
  }
  const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
  // Backfill: PUT every existing pending reminder to the CalDAV server. The
  // reminder id is the URL key, so re-pushing is idempotent (PUT overwrites).
  // Fire-and-forget so the settings save doesn't wait on N HTTP round-trips.
  if (s && s.enabled) {
    backfillCaldavReminders(s).catch(err =>
      console.error('CalDAV backfill failed:', err.message)
    );
  }
  res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
}));

async function backfillCaldavReminders(settings) {
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [settings.userId]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  for (const reminder of enrichedReminders) {
    try {
      await pushReminderToCaldav(settings, reminder);
    } catch (err) {
      console.error(`CalDAV backfill failed for reminder ${reminder.id}:`, err.message);
    }
  }
}

app.delete('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  await run('DELETE FROM caldav_settings WHERE userId = ?', [req.user.id]);
  res.status(204).end();
}));

app.post('/api/caldav/test', requireAuth, asyncRoute(async (req, res) => {
  const { calendarUrl, username, password } = req.body;
  if (!calendarUrl || !username || !password) {
    return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
  }
  try {
    const result = await testCaldavConnection({ calendarUrl, username, password });
    res.json({ ok: true, httpStatus: result.status });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// ─── Google Calendar routes ────────────────────────────────────────────────

app.get('/api/google-calendar/status', requireAuth, asyncRoute(async (req, res) => {
  const row = await get('SELECT clientId, accessToken, enabled FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  res.json({
    hasCredentials: !!row,
    connected: !!(row?.accessToken),
    enabled: !!(row?.enabled),
    clientId: row?.clientId || null
  });
}));

app.put('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
  const { clientId, clientSecret, enabled } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });
  const now = new Date().toISOString();
  const existing = await get('SELECT userId, clientSecret FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  const isPlaceholder = clientSecret === '••••••••';
  if (existing) {
    if (isPlaceholder) {
      await run('UPDATE google_calendar_tokens SET clientId = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
        [clientId, enabled ? 1 : 0, now, req.user.id]);
    } else {
      await run('UPDATE google_calendar_tokens SET clientId = ?, clientSecret = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
        [clientId, clientSecret, enabled ? 1 : 0, now, req.user.id]);
    }
  } else {
    if (isPlaceholder) return res.status(400).json({ error: 'Client secret is required.' });
    await run(
      'INSERT INTO google_calendar_tokens (userId, clientId, clientSecret, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, clientId, clientSecret, enabled ? 1 : 0, now, now]
    );
  }
  res.json({ ok: true });
}));

app.post('/api/auth/google/initiate', requireAuth, asyncRoute(async (req, res) => {
  const row = await get('SELECT clientId FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  if (!row?.clientId) return res.status(400).json({ error: 'Google credentials not configured.' });
  const state = randomHex(16);
  oauthStates.set(state, { userId: req.user.id, createdAt: Date.now() });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: row.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}));

app.get('/api/auth/google/callback', asyncRoute(async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent(String(error || 'Authorization cancelled.')));
  }
  const stateData = oauthStates.get(String(state));
  if (!stateData) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent('Invalid or expired state. Please try again.'));
  }
  oauthStates.delete(String(state));
  const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ?', [stateData.userId]);
  if (!row) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent('Credentials not found. Please save them first.'));
  }
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  try {
    const tokens = await exchangeGoogleCode(row.clientId, row.clientSecret, String(code), redirectUri);
    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    await run(
      'UPDATE google_calendar_tokens SET accessToken = ?, refreshToken = COALESCE(?, refreshToken), tokenExpiry = ?, enabled = 1, updatedAt = ? WHERE userId = ?',
      [tokens.access_token, tokens.refresh_token || null, expiry, new Date().toISOString(), stateData.userId]
    );
    // Backfill: push any existing pending reminders that haven't been synced
    // yet. Fire-and-forget so the OAuth redirect isn't held up by the
    // calendar API round-trips. gcalCreateAndStore writes the event ID back
    // onto each reminder so future updates/deletes find them.
    backfillGoogleCalendarReminders(stateData.userId).catch(err =>
      console.error('GCal backfill failed:', err.message)
    );
    res.redirect('/settings?google=connected');
  } catch (err) {
    res.redirect('/settings?google=error&message=' + encodeURIComponent(err.message));
  }
}));

async function backfillGoogleCalendarReminders(userId) {
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND reminders.gcalEventId IS NULL
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [userId]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  for (const reminder of enrichedReminders) {
    try {
      await gcalCreateAndStore(userId, reminder, token);
    } catch (err) {
      console.error(`GCal backfill failed for reminder ${reminder.id}:`, err.message);
    }
  }
}

app.delete('/api/google-calendar/disconnect', requireAuth, asyncRoute(async (req, res) => {
  await run(
    'UPDATE google_calendar_tokens SET accessToken = NULL, refreshToken = NULL, tokenExpiry = NULL, updatedAt = ? WHERE userId = ?',
    [new Date().toISOString(), req.user.id]
  );
  res.status(204).end();
}));

app.delete('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
  await run('DELETE FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  res.status(204).end();
}));

// ─── Update check ───────────────────────────────────────────────────────────

const updateCheckCache = { latest: null, fetchedAt: 0, error: null, inFlight: null };
const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;

function compareVersion(a, b) {
  // Two-part major.minor scheme (e.g. "1.1", "1.20", "2.3"). Strips leading
  // "v" and any "-prerelease" suffix. Extra parts (e.g. "1.2.3") are ignored
  // so legacy three-part values still compare predictably. Returns -1/0/1.
  const norm = v => String(v || '0.0').replace(/^v/i, '').split('-')[0];
  const pa = norm(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = norm(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 2; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(GITHUB_RELEASES_URL, {
      headers: {
        'User-Agent': `Kept/${KEPT_VERSION}`,
        Accept: 'application/vnd.github+json'
      },
      timeout: 8000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub returned ${res.statusCode}`));
        try {
          const body = JSON.parse(data);
          resolve({
            version: String(body.tag_name || body.name || '').replace(/^v/i, ''),
            url: body.html_url || `https://github.com/ericerkz/kept/releases`,
            notes: String(body.body || '').slice(0, 5000),
            publishedAt: body.published_at || null
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function getLatestRelease() {
  const now = Date.now();
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
    return updateCheckCache.latest;
  }
  if (updateCheckCache.inFlight) return updateCheckCache.inFlight;
  updateCheckCache.inFlight = fetchLatestRelease()
    .then(latest => {
      updateCheckCache.latest = latest;
      updateCheckCache.fetchedAt = Date.now();
      updateCheckCache.error = null;
      return latest;
    })
    .catch(e => {
      updateCheckCache.error = e.message;
      return updateCheckCache.latest;
    })
    .finally(() => {
      updateCheckCache.inFlight = null;
    });
  return updateCheckCache.inFlight;
}

function getCachedLatestRelease() {
  const now = Date.now();
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
    return updateCheckCache.latest;
  }
  return updateCheckCache.latest;
}

function refreshLatestReleaseInBackground() {
  const now = Date.now();
  if (updateCheckCache.inFlight) return;
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) return;
  getLatestRelease().catch(() => undefined);
}

// Fire a check at startup so the first admin who logs in sees it without delay.
setTimeout(() => refreshLatestReleaseInBackground(), 5000).unref?.();

// ─── Link preview ────────────────────────────────────────────────────────────

const linkPreviewCache = new Map(); // url -> { data, fetchedAt }

function normalizeIpAddress(address) {
  if (!address) return '';
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : address;
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

function inCidrV4(ip, cidrBase, prefix) {
  const ipNum = ipToLong(ip);
  const baseNum = ipToLong(cidrBase);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipNum & mask) === (baseNum & mask);
}

function isPrivateOrLocalAddress(address) {
  const normalized = normalizeIpAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true;
  if (family === 4) {
    return (
      inCidrV4(normalized, '0.0.0.0', 8) ||
      inCidrV4(normalized, '10.0.0.0', 8) ||
      inCidrV4(normalized, '100.64.0.0', 10) ||
      inCidrV4(normalized, '127.0.0.0', 8) ||
      inCidrV4(normalized, '169.254.0.0', 16) ||
      inCidrV4(normalized, '172.16.0.0', 12) ||
      inCidrV4(normalized, '192.0.0.0', 24) ||
      inCidrV4(normalized, '192.0.2.0', 24) ||
      inCidrV4(normalized, '192.168.0.0', 16) ||
      inCidrV4(normalized, '198.18.0.0', 15) ||
      inCidrV4(normalized, '198.51.100.0', 24) ||
      inCidrV4(normalized, '203.0.113.0', 24) ||
      inCidrV4(normalized, '224.0.0.0', 4) ||
      inCidrV4(normalized, '240.0.0.0', 4)
    );
  }
  const value = normalized.toLowerCase();
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    value.startsWith('fec0:') ||
    value.startsWith('ff')
  );
}

async function resolvePublicIp(hostname) {
  const lookups = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!lookups.length) throw new Error('Host resolution failed');
  const sortedLookups = [
    ...lookups.filter(result => result.family === 4),
    ...lookups.filter(result => result.family !== 4)
  ];
  for (const result of sortedLookups) {
    if (!isPrivateOrLocalAddress(result.address)) return result;
  }
  throw new Error('Private network targets are blocked');
}

async function publicRequestOptions(targetUrl, baseOptions = {}) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
  const resolved = await resolvePublicIp(parsed.hostname);
  return {
    ...baseOptions,
    lookup: (_hostname, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      const lookupOptions = typeof options === 'function' ? {} : (options || {});
      if (lookupOptions.all) {
        done(null, [{ address: resolved.address, family: resolved.family }]);
        return;
      }
      done(null, resolved.address, resolved.family);
    }
  };
}

function fetchHtml(url, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    async function doFetch(currentUrl, hopsLeft) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (e) { return reject(e); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Unsupported protocol'));
      let requestOptions;
      try {
        requestOptions = await publicRequestOptions(currentUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 8000
        });
      } catch (e) { return reject(e); }
      const mod = parsed.protocol === 'https:' ? require('https') : require('http');
      const req = mod.get(currentUrl, requestOptions, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hopsLeft > 0) {
          res.resume();
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
          return doFetch(next, hopsLeft - 1);
        }
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 500000) { req.destroy(); resolve(data); } });
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
    }
    doFetch(url, maxRedirects);
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAttributes(tag) {
  const attrs = {};
  tag.replace(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_m, key, dq, sq, bare) => {
    attrs[key.toLowerCase()] = decodeHtml(dq ?? sq ?? bare ?? '').trim();
    return '';
  });
  return attrs;
}

function absolutizeUrl(value, baseUrl) {
  if (!value) return null;
  const cleaned = decodeHtml(value).trim();
  if (!cleaned || /^data:|^javascript:/i.test(cleaned)) return null;
  try { return new URL(cleaned, baseUrl).href; } catch { return null; }
}

function bestSrcsetUrl(value) {
  let best = null;
  for (const candidate of String(value || '').split(',')) {
    const parts = candidate.trim().split(/\s+/);
    const url = parts[0] || '';
    const descriptor = parts[1] || '';
    let score = 1;
    if (descriptor.endsWith('w')) score = Number.parseInt(descriptor, 10) || 1;
    else if (descriptor.endsWith('x')) score = (Number.parseFloat(descriptor) || 1) * 1000;
    if (url && (!best || score > best.score)) best = { url, score };
  }
  return best?.url || '';
}

function collectJsonLdImages(html, baseUrl) {
  const images = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(decodeHtml(match[1]));
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;
        const image = item.image;
        if (typeof image === 'string') images.push(image);
        else if (Array.isArray(image)) images.push(...image.filter(x => typeof x === 'string'));
        else if (image && typeof image === 'object' && typeof image.url === 'string') images.push(image.url);
        for (const value of Object.values(item)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    } catch {}
  }
  return images.map(image => absolutizeUrl(image, baseUrl)).filter(Boolean);
}

function collectDynamicImageUrls(value, baseUrl) {
  const images = [];
  try {
    const data = JSON.parse(decodeHtml(value));
    if (data && typeof data === 'object') {
      for (const [url, dimensions] of Object.entries(data)) {
        images.push({
          url: absolutizeUrl(url, baseUrl),
          width: Array.isArray(dimensions) ? Number(dimensions[0]) || 0 : 0,
          height: Array.isArray(dimensions) ? Number(dimensions[1]) || 0 : 0
        });
      }
    }
  } catch {}
  return images.filter(image => image.url);
}

function previewImageScore(candidate) {
  const url = String(candidate.url || '');
  const lower = url.toLowerCase();
  let score = candidate.priority || 0;
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  const area = width * height;

  if (area >= 120000) score += 220;
  else if (area >= 40000) score += 140;
  else if (width && height && area < 10000) score -= 500;
  else if (!width && !height) score -= 20;

  if (/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/.test(lower)) score += 80;
  if (/\/(?:image|images|media|photo|photos|product|products|assets)\//.test(lower)) score += 50;
  if (/(?:og|twitter|social|share|card)[-_./]?image/.test(lower)) score += 80;
  if (/m\.media-amazon\.com|ssl-images-amazon\.com|images-na\.ssl-images-amazon\.com/.test(lower)) score += 140;
  if (/favicon|apple-touch-icon|\/icon[-_.]?|\.ico(?:[?#]|$)/.test(lower)) score -= 700;
  if (/sprite|spacer|blank|transparent|pixel|tracking|loader|placeholder/.test(lower)) score -= 600;
  if (/logo|brand/.test(lower)) score -= 160;
  if (/\/(?:16|24|32|48|64)x(?:16|24|32|48|64)\//.test(lower) || /(?:^|[-_])(?:16|24|32|48|64)(?:[-_.x])/.test(lower)) score -= 350;
  if (/\.svg(?:[?#]|$)/.test(lower)) score -= 120;
  return score;
}

function bestPreviewImage(candidates, baseUrl) {
  const seen = new Set();
  const normalized = [];
  for (const candidate of candidates) {
    const url = absolutizeUrl(candidate.url || candidate, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push({ ...candidate, url });
  }
  normalized.sort((a, b) => previewImageScore(b) - previewImageScore(a));
  return normalized[0]?.url || null;
}

function previewScreenshotUrl(baseUrl) {
  if (process.env.KEPT_LINK_PREVIEW_SCREENSHOTS === '0') return null;
  try {
    const target = new URL(baseUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    target.hash = '';
    return `https://image.thum.io/get/width/640/crop/360/noanimate/${target.href}`;
  } catch {
    return null;
  }
}

function parseOgMeta(html, baseUrl) {
  const meta = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
  }
  const getMeta = (...names) => {
    for (const name of names) {
      const value = meta.get(name.toLowerCase());
      if (value) return value;
    }
    return null;
  };
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);

  const imageCandidates = [];
  const addCandidate = (url, priority, dimensions = {}) => {
    if (url) imageCandidates.push({ url, priority, ...dimensions });
  };

  addCandidate(
    getMeta('og:image:secure_url', 'og:image:url', 'og:image'),
    1100,
    { width: Number(getMeta('og:image:width')) || 0, height: Number(getMeta('og:image:height')) || 0 }
  );
  addCandidate(
    getMeta('twitter:image:src', 'twitter:image'),
    1050,
    { width: Number(getMeta('twitter:image:width')) || 0, height: Number(getMeta('twitter:image:height')) || 0 }
  );
  for (const image of collectJsonLdImages(html, baseUrl)) addCandidate(image, 900);

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const rel = (attrs.rel || '').toLowerCase();
    if (rel.includes('image_src')) addCandidate(attrs.href, 850);
    else if (rel.includes('apple-touch-icon')) addCandidate(attrs.href, 180);
    else if (rel.includes('icon')) addCandidate(attrs.href, 80);
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const width = Number(attrs.width || attrs['data-width']) || 0;
    const height = Number(attrs.height || attrs['data-height']) || 0;
    const dimensions = { width, height };
    addCandidate(attrs['data-old-hires'], 760, dimensions);
    addCandidate(attrs['data-a-hires'], 760, dimensions);
    addCandidate(attrs['data-large-image'], 740, dimensions);
    addCandidate(bestSrcsetUrl(attrs.srcset || attrs['data-srcset']), 680, dimensions);
    addCandidate(attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'], 620, dimensions);
    for (const image of collectDynamicImageUrls(attrs['data-a-dynamic-image'], baseUrl)) {
      addCandidate(image.url, 820, { width: image.width, height: image.height });
    }
  }

  // Deep Scan for absolute URLs ending in image extensions
  const deepScanRegex = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|avif|svg)(?:\?[^"'\s]*)?/gi;
  const deepMatches = html.match(deepScanRegex);
  if (deepMatches) {
    for (const image of deepMatches) addCandidate(image, 520);
  }

  let bestImage = bestPreviewImage(imageCandidates, baseUrl);

  // Screenshot fallback handles sites that block server-side HTML fetches or
  // do not publish useful OpenGraph imagery. Set
  // KEPT_LINK_PREVIEW_SCREENSHOTS=0 to avoid using the third-party service.
  if (!bestImage) {
    bestImage = previewScreenshotUrl(baseUrl);
  }

  // Final fallback: High-res Google Favicon
  if (!bestImage) {
    try {
      const domain = new URL(baseUrl).hostname;
      bestImage = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
    } catch {}
  }

  return {
    title: getMeta('og:title', 'twitter:title') || (titleMatch ? decodeHtml(titleMatch[1]).trim() : null),
    description: getMeta('og:description') || getMeta('description') || null,
    image: bestImage || null,
  };
}

app.get('/api/link-preview', requireAuth, asyncRoute(async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const cached = linkPreviewCache.get(url);
  if (cached && cached.fetchedAt > Date.now() - 3600000) return res.json(cached.data);

  try {
    const html = await fetchHtml(url);
    const meta = parseOgMeta(html, url);
    const domain = parsed.hostname.replace(/^www\./, '');
    const data = { title: meta.title || domain, description: meta.description, image: meta.image, url, domain };
    linkPreviewCache.set(url, { data, fetchedAt: Date.now() });
    res.json(data);
  } catch (err) {
    const domain = parsed.hostname.replace(/^www\./, '');
    const fallback = {
      title: domain,
      description: null,
      image: `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      url,
      domain
    };
    res.json(fallback);
  }
}));

app.get('/api/proxy-image', requireAuthOrQueryToken, asyncRoute(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');

  async function doProxy(targetUrl, redirectsLeft = 3) {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { if (!res.headersSent) res.status(400).send('Invalid URL'); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      if (!res.headersSent) res.status(400).send('Invalid protocol');
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    let requestOptions;
    try {
      requestOptions = await publicRequestOptions(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        },
        timeout: 10000
      });
    } catch {
      if (!res.headersSent) res.status(400).send('Private network targets are blocked');
      return;
    }
    const proxyReq = transport.get(targetUrl, requestOptions, (proxyRes) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && redirectsLeft > 0) {
        proxyRes.resume();
        return doProxy(absolutizeUrl(proxyRes.headers.location, targetUrl), redirectsLeft - 1);
      }

      if (proxyRes.statusCode >= 400) {
        return res.status(proxyRes.statusCode).send('Upstream error');
      }

      const contentType = String(proxyRes.headers['content-type'] || 'image/jpeg').toLowerCase();
      if (!contentType.startsWith('image/')) {
        proxyRes.resume();
        if (!res.headersSent) res.status(415).send('Not an image');
        return;
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error('Proxy Image Error:', err.message, 'for URL:', targetUrl);
      if (!res.headersSent) res.status(500).send('Proxy error');
    });
  }

  await doProxy(url);
}));

// ─── Google Takeout import ───────────────────────────────────────────────────

const KEEP_COLOR_MAP = {
  DEFAULT: '', WHITE: '', GRAY: '',
  RED: '#f8c7c0', ORANGE: '#fddcbb', YELLOW: '#fff8b8',
  GREEN: '#ccff90', TEAL: '#e6f4d7', BLUE: '#d2e3fc',
  CERULEAN: '#cbf0f8', PURPLE: '#d7aefb', PINK: '#fdcfe8',
  BROWN: '#fddcbb',
};

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname?.toLowerCase().endsWith('.zip');
    ok ? cb(null, true) : cb(new Error('Only ZIP files are supported.'));
  }
});

// Limits for Google Takeout zips. Real Keep exports are usually well under
// these caps; the goal is to prevent zip bombs and path-traversal entries
// without breaking large legitimate exports.
const TAKEOUT_MAX_ENTRIES = 50_000;
const TAKEOUT_MAX_PER_ENTRY_BYTES = 100 * 1024 * 1024;     // 100 MB per file
const TAKEOUT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;    // 5 GB combined
const TAKEOUT_MAX_FILENAME_LEN = 1024;

function normalizeZipEntryName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isUnsafeZipPath(name) {
  // Reject any traversal segments or absolute paths. We don't write entry
  // names to disk (we generate our own filenames), but we still treat unsafe
  // paths as a strong signal the upload is malicious.
  if (!name || name.length > TAKEOUT_MAX_FILENAME_LEN) return true;
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return true;
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.' && false) return true;
    if (segment === '..') return true;
  }
  return false;
}

function isKeepJsonEntry(entry) {
  return !entry.isDirectory && /(^|\/)(?:Takeout\/)?Keep\/[^/]+\.json$/i.test(entry.entryName);
}

async function readZipEntries(buffer) {
  let admZipError;
  let rawEntries;
  let getRawData;
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    rawEntries = zip.getEntries();
    getRawData = (entry) => entry.getData();
  } catch (error) {
    admZipError = error;
  }

  if (!rawEntries) {
    try {
      const unzipper = require('unzipper');
      const directory = await unzipper.Open.buffer(buffer);
      rawEntries = directory.files.map(file => ({
        entryName: file.path,
        isDirectory: file.type === 'Directory' || /\/$/.test(file.path),
        _file: file
      }));
      getRawData = (entry) => entry._file.buffer();
    } catch (error) {
      console.error('Takeout ZIP parse error:', admZipError?.message || admZipError, error?.message || error);
      throw new Error('Invalid ZIP file. Upload the Google Takeout ZIP itself, with the stock Takeout/Keep folder inside it.');
    }
  }

  if (rawEntries.length > TAKEOUT_MAX_ENTRIES) {
    throw new Error(`ZIP has too many entries (${rawEntries.length}, max ${TAKEOUT_MAX_ENTRIES}).`);
  }

  let totalExtracted = 0;
  const entries = [];
  for (const raw of rawEntries) {
    const rawName = raw.entryName ?? raw.path ?? '';
    const normalized = normalizeZipEntryName(rawName);
    if (isUnsafeZipPath(normalized)) {
      throw new Error('ZIP contains an unsafe entry path. Aborting.');
    }
    entries.push({
      entryName: normalized,
      isDirectory: !!(raw.isDirectory ?? raw.type === 'Directory'),
      getData: async () => {
        const data = await getRawData(raw);
        if (!data) return Buffer.alloc(0);
        if (data.length > TAKEOUT_MAX_PER_ENTRY_BYTES) {
          throw new Error(`Entry "${normalized}" is too large (${data.length} bytes). Max ${TAKEOUT_MAX_PER_ENTRY_BYTES}.`);
        }
        totalExtracted += data.length;
        if (totalExtracted > TAKEOUT_MAX_TOTAL_BYTES) {
          throw new Error('ZIP expands beyond the safe extraction limit (possible zip bomb).');
        }
        return data;
      }
    });
  }
  return entries;
}

app.post('/api/import/google-takeout', requireAuth, uploadZip.single('takeout'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let entries;
  try {
    entries = await readZipEntries(req.file.buffer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const attachmentsByName = {};
  for (const e of entries) {
    if (!e.isDirectory) attachmentsByName[path.basename(e.entryName)] = e;
  }

  const jsonEntries = entries.filter(isKeepJsonEntry);
  if (!jsonEntries.length) {
    return res.status(400).json({ error: 'No Google Keep notes found in this ZIP. Upload the full Takeout ZIP that contains Takeout/Keep/*.json files.' });
  }

  let imported = 0, skipped = 0, errors = 0, pinnedCount = 0, deduped = 0;
  const now = new Date().toISOString();
  const fieldPresence = { isPinned: 0, pinned: 0, isArchived: 0, archived: 0 };

  // Build a fingerprint set of existing notes for this user so re-running
  // the takeout import doesn't silently double everything. Fingerprint =
  // createdAt + first 200 chars of title + body, which Google's exports
  // keep stable across re-exports.
  const existingFingerprints = new Set();
  const existingRows = await all('SELECT noteTitle, noteBody, createdAt FROM notes WHERE ownerUserId = ?', [req.user.id]);
  for (const row of existingRows) {
    const fp = `${row.createdAt}|${(row.noteTitle || '').slice(0, 200)}|${(row.noteBody || '').slice(0, 200)}`;
    existingFingerprints.add(fp);
  }

  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const entry of jsonEntries) {
      try {
        let note;
        try { note = JSON.parse((await entry.getData()).toString('utf8')); }
        catch (e) {
          if (e && /zip bomb|too many entries|too large|unsafe entry/i.test(e.message)) throw e;
          errors++; continue;
        }

        if (note.isTrashed) { skipped++; continue; }

        const bgColor = KEEP_COLOR_MAP[note.color] ?? '';

        let noteBody = '';
        if (note.textContent) {
          noteBody = note.textContent
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        }
        if (note.annotations?.length) {
          const links = note.annotations
            .filter(a => a.url)
            .map(a => `<a href="${a.url}" target="_blank" rel="noopener">${a.title || a.url}</a>`)
            .join('<br>');
          if (links) noteBody = noteBody ? `${noteBody}<br>${links}` : links;
        }

        let isCbox = 0, checkBoxes = [];
        if (note.listContent?.length) {
          isCbox = 1;
          checkBoxes = note.listContent.map((item, i) => ({
            id: `imp-${Date.now()}-${i}`,
            data: (item.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            done: item.isChecked || false
          }));
        }

        const images = [];
        for (const att of (note.attachments || [])) {
          const attMimeType = String(att.mimetype || '').toLowerCase();
          if (!SAFE_IMAGE_TYPES.has(attMimeType)) continue;
          const basename = path.basename(att.filePath || '');
          const attEntry = attachmentsByName[basename];
          if (!attEntry) continue;
          try {
            const ext = SAFE_IMAGE_TYPES.get(attMimeType);
            const filename = `${Date.now()}-${randomHex(12)}${ext}`;
            const data = await attEntry.getData();
            fs.writeFileSync(path.join(uploadDir, filename), data);
            images.push({ id: `img-${Date.now()}`, dataUrl: `${PRIVATE_IMAGE_PREFIX}${filename}`, name: basename, placement: 'top' });
          } catch (e) {
            if (e && /zip bomb|too many entries|too large|unsafe entry/i.test(e.message)) throw e;
            /* skip image */
          }
        }

        const labels = (note.labels || []).map(l => ({ name: l.name, added: true }));
        const createdAt = note.createdTimestampUsec ? new Date(note.createdTimestampUsec / 1000).toISOString() : now;
        const updatedAt = note.userEditedTimestampUsec ? new Date(note.userEditedTimestampUsec / 1000).toISOString() : now;

        // Skip notes that look like a re-import of something already present.
        const noteTitle = plainText(note.title || '') || '';
        const fingerprint = `${createdAt}|${noteTitle.slice(0, 200)}|${noteBody.slice(0, 200)}`;
        if (existingFingerprints.has(fingerprint)) { deduped++; continue; }
        existingFingerprints.add(fingerprint);

        // Google Keep Takeout uses `isPinned`; older or third-party exports
        // sometimes use `pinned`. Accept either to avoid silently dropping pins.
        if ('isPinned' in note) fieldPresence.isPinned++;
        if ('pinned' in note) fieldPresence.pinned++;
        if ('isArchived' in note) fieldPresence.isArchived++;
        if ('archived' in note) fieldPresence.archived++;
        const pinnedFlag = (note.isPinned || note.pinned) ? 1 : 0;
        const archivedFlag = (note.isArchived || note.archived) ? 1 : 0;
        if (pinnedFlag) pinnedCount++;
        // Keep imported notes in their original Keep recency order instead of
        // treating the import itself as the note date.
        const importSortOrder = new Date(updatedAt || createdAt || now).getTime() || Date.now();
        const insertResult = await run(
          `INSERT INTO notes (ownerUserId, noteTitle, noteBody, pinned, bgColor, bgImage, checkBoxes, images, isCbox, labels, archived, trashed, sortOrder, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [req.user.id, noteTitle, noteBody, pinnedFlag, bgColor,
           JSON.stringify(checkBoxes), JSON.stringify(images), isCbox, JSON.stringify(labels),
           archivedFlag, importSortOrder, createdAt, updatedAt]
        );
        // The /api/notes endpoint resolves `pinned` from the per-user
        // `user_pins` table, not the legacy `notes.pinned` column. Without
        // this insert, takeout-imported pinned notes would never appear
        // pinned in the UI.
        if (pinnedFlag) {
          await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, insertResult.id]);
        }
        await syncNoteImagesForNote(insertResult.id, req.user.id, { noteBody, images });
        imported++;
      } catch (e) { console.error('Takeout import error:', entry.entryName, e.message); errors++; }
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    if (error && /zip bomb|too many entries|too large|unsafe entry/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  console.log(
    `[Takeout import] user=${req.user.id} total=${jsonEntries.length} imported=${imported} skipped=${skipped} deduped=${deduped} errors=${errors} pinned=${pinnedCount}`,
    'fields=', fieldPresence
  );

  broadcastRealtime([req.user.id], { type: 'notes-changed' });
  res.json({ imported, skipped, deduped, errors, pinnedCount, total: jsonEntries.length, fieldPresence });
}));

if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : error.message;
    return res.status(400).json({ error: message });
  }
  if (String(error?.message || '').startsWith('Only PNG, JPG, GIF, and WEBP uploads are supported.') || error.message === 'Only ZIP files are supported.' || error.message === 'This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.') {
    return res.status(400).json({ error: error.message });
  }

  if (error && error.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }

  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Server error.' });
});

init().then(() => {
  setupRealtime();
  startReminderScheduler();
  startBackupScheduler();
  server.listen(port, () => {
    console.log(`Keep API listening on http://127.0.0.1:${port}`);
    console.log(`Keep realtime listening on ws://127.0.0.1:${port}/api/realtime`);
    console.log(`SQLite database: ${dbPath}`);
    scheduleStartupMaintenance();
  });
}).catch(error => {
  console.error(error);
  process.exit(1);
});
