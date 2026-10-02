const DEFAULT_TIMEOUT_MS = 10_000;
const BLOCKED_HEADER_NAMES = new Set(['authorization', 'cookie', 'host', 'content-length', 'connection', 'accept-encoding']);

export class KeptApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'KeptApiError';
    this.status = status;
    this.code = code;
  }
}

function connectionHeaders(value) {
  if (!value) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new KeptApiError('KEPT_CUSTOM_HEADERS_JSON must be valid JSON.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new KeptApiError('KEPT_CUSTOM_HEADERS_JSON must be a JSON object.');
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const name = String(rawName || '').trim();
    const headerValue = String(rawValue ?? '').trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !headerValue) throw new KeptApiError('Custom header names and values must be non-empty and valid.');
    if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) throw new KeptApiError(`Custom header ${name} is not allowed.`);
    headers[name] = headerValue;
  }
  return headers;
}

export function loadKeptConfig(env = process.env) {
  const baseUrl = String(env.KEPT_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new KeptApiError('KEPT_BASE_URL is required.');
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { throw new KeptApiError('KEPT_BASE_URL must be a valid http or https URL.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new KeptApiError('KEPT_BASE_URL must use http or https.');
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new KeptApiError('KEPT_BASE_URL cannot contain credentials, a query, or a fragment.');
  const token = String(env.KEPT_MCP_TOKEN || '').trim();
  if (!token) throw new KeptApiError('KEPT_MCP_TOKEN is required. Enable Agent Access in Kept settings and generate a token.');
  const timeoutMs = Number(env.KEPT_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new KeptApiError('KEPT_REQUEST_TIMEOUT_MS must be between 100 and 120000 milliseconds.');
  return { baseUrl, token, timeoutMs, customHeaders: connectionHeaders(env.KEPT_CUSTOM_HEADERS_JSON) };
}

function responseMessage(payload, status) {
  if (payload && typeof payload === 'object' && typeof payload.error === 'string') return payload.error.slice(0, 500);
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 500);
  return `Kept API returned HTTP ${status}.`;
}

async function readResponse(response, responseType) {
  if (response.status === 204) return null;
  if (responseType === 'bytes') return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    disposition: response.headers.get('content-disposition') || ''
  };
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : response.text();
}

export class KeptClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new KeptApiError('A Fetch API implementation is required.');
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body, formData, responseType = 'json' } = {}) {
    const headers = {
      accept: responseType === 'bytes' ? '*/*' : 'application/json',
      authorization: `Bearer ${this.config.token}`,
      'user-agent': 'kept-mcp/2.0',
      ...this.config.customHeaders
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(formData ? { body: formData } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      const pathname = new URL(path, this.config.baseUrl).pathname;
      throw new KeptApiError(`${method} ${pathname} failed: ${error.message}`, { code: 'NETWORK_ERROR' });
    }
    if (response.status >= 300 && response.status < 400) throw new KeptApiError('Kept refused an HTTP redirect so access credentials are not forwarded to another origin.', { status: response.status, code: 'REDIRECT_BLOCKED' });
    const payload = await readResponse(response, responseType);
    if (!response.ok) throw new KeptApiError(responseMessage(payload, response.status), { status: response.status, code: 'API_ERROR' });
    return payload;
  }

  status() { return this.request('/api/mcp/status'); }
  listLabels() { return this.request('/api/labels'); }
  searchUsers(query) { return this.request(`/api/users/search?q=${encodeURIComponent(query)}`); }
  searchNotes(query) { return this.request(`/api/notes/search?q=${encodeURIComponent(query)}`); }
  getNote(noteId) { return this.request(`/api/notes/${noteId}`); }
  createNote(note) { return this.request('/api/notes', { method: 'POST', body: note }); }
  async updateNote(noteId, changes) {
    await this.request(`/api/notes/${noteId}`, { method: 'PATCH', body: changes });
    return this.getNote(noteId);
  }

  async assertNoteOwner(noteId, action, note) {
    const [status, currentNote] = await Promise.all([
      this.status(),
      note ? Promise.resolve(note) : this.getNote(noteId)
    ]);
    if (Number(currentNote.ownerUserId) !== Number(status.userId)) {
      throw new KeptApiError(`Only the note owner can ${action}.`, { status: 403, code: 'OWNER_REQUIRED' });
    }
    return currentNote;
  }

  async resolveLabels(names) {
    const existing = await this.listLabels();
    const byName = new Map(existing.map(label => [String(label.name).toLowerCase(), label]));
    const resolved = [];
    const selected = new Set();
    for (const rawName of names) {
      const name = String(rawName).trim();
      const key = name.toLowerCase();
      if (!name || selected.has(key)) continue;
      selected.add(key);
      let label = byName.get(key);
      if (!label) {
        label = await this.request('/api/labels/find-or-create', { method: 'POST', body: { name } });
        byName.set(key, label);
      }
      resolved.push({ id: label.id, name: label.name, added: true });
    }
    return resolved;
  }

  async setLifecycle(noteId, state) {
    await this.assertNoteOwner(noteId, `${state} this note`);
    const changes = state === 'archive' ? { archived: true, trashed: false } : state === 'trash' ? { archived: false, trashed: true } : { archived: false, trashed: false };
    return this.updateNote(noteId, changes);
  }
  async permanentlyDeleteNote(noteId) {
    await this.assertNoteOwner(noteId, 'permanently delete this note');
    await this.request(`/api/notes/${noteId}`, { method: 'DELETE' });
    return { ok: true, noteId };
  }

  listReminders() { return this.request('/api/reminders'); }
  createReminder(reminder) { return this.request('/api/reminders', { method: 'POST', body: reminder }); }
  updateReminder(reminderId, changes) { return this.request(`/api/reminders/${reminderId}`, { method: 'PATCH', body: changes }); }
  async deleteReminder(reminderId) {
    await this.request(`/api/reminders/${reminderId}`, { method: 'DELETE' });
    return { ok: true, reminderId };
  }

  getCollaborators(noteId) { return this.request(`/api/notes/${noteId}/collaborators`); }
  setCollaborators(noteId, userIds) { return this.request(`/api/notes/${noteId}/collaborators`, { method: 'PUT', body: { userIds } }); }

  async uploadImage({ filename, mimeType, base64Data }) {
    const form = new FormData();
    form.append('image', new Blob([Buffer.from(base64Data, 'base64')], { type: mimeType }), filename);
    return this.request('/api/uploads/images', { method: 'POST', formData: form });
  }

  async readImage(noteId, imageId) {
    const note = await this.getNote(noteId);
    const image = (note.images || []).find(candidate => String(candidate?.id) === String(imageId));
    if (!image) throw new KeptApiError('Image not found on this note.', { status: 404, code: 'IMAGE_NOT_FOUND' });
    const source = String(image.dataUrl || '');
    const inline = source.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (inline) return { contentType: inline[1].toLowerCase(), base64Data: inline[2].replace(/\s/g, ''), name: image.name || 'image' };

    let parsed;
    try { parsed = new URL(source, this.config.baseUrl); } catch { throw new KeptApiError('This note image has an invalid URL.'); }
    const base = new URL(this.config.baseUrl);
    if (parsed.origin !== base.origin) throw new KeptApiError('External note images cannot be fetched through Kept MCP.');
    const match = parsed.pathname.match(/^\/(?:api\/uploads\/images|uploads)\/([^/]+)$/);
    if (!match) throw new KeptApiError('This note image is not stored in Kept.');
    const result = await this.request(`/api/uploads/images/${encodeURIComponent(decodeURIComponent(match[1]))}`, { responseType: 'bytes' });
    return { contentType: result.contentType, base64Data: result.bytes.toString('base64'), name: image.name || match[1] };
  }

  async uploadAttachment(noteId, { filename, mimeType, base64Data }) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64Data, 'base64')], { type: mimeType }), filename);
    return this.request(`/api/notes/${noteId}/attachments`, { method: 'POST', formData: form });
  }
  async readAttachment(attachmentId) {
    const result = await this.request(`/api/attachments/${attachmentId}`, { responseType: 'bytes' });
    return { contentType: result.contentType, disposition: result.disposition, base64Data: result.bytes.toString('base64') };
  }
  async deleteAttachment(noteId, attachmentId) {
    await this.request(`/api/notes/${noteId}/attachments/${attachmentId}`, { method: 'DELETE' });
    return { ok: true, noteId, attachmentId };
  }
  requestLockedNoteAccess(noteId) { return this.request(`/api/mcp/locked-notes/${noteId}/unlock`, { method: 'POST', body: {} }); }
}
