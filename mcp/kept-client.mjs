const DEFAULT_TIMEOUT_MS = 10_000;

export class KeptApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'KeptApiError';
    this.status = status;
    this.code = code;
  }
}

export function loadKeptConfig(env = process.env) {
  const baseUrl = String(env.KEPT_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new KeptApiError('KEPT_BASE_URL is required.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new KeptApiError('KEPT_BASE_URL must be a valid http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new KeptApiError('KEPT_BASE_URL must use http or https.');
  }

  const token = String(env.KEPT_TOKEN || '').trim();
  const username = String(env.KEPT_USERNAME || '').trim();
  const password = String(env.KEPT_PASSWORD || '');
  if (!token && (!username || !password)) {
    throw new KeptApiError(
      'Set KEPT_TOKEN or both KEPT_USERNAME and KEPT_PASSWORD. A dedicated non-admin Kept user is recommended.'
    );
  }

  const configuredTimeout = Number(env.KEPT_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout < 100 || configuredTimeout > 120_000) {
    throw new KeptApiError('KEPT_REQUEST_TIMEOUT_MS must be between 100 and 120000 milliseconds.');
  }

  return {
    baseUrl,
    token,
    username,
    password,
    timeoutMs: configuredTimeout
  };
}

function responseMessage(payload, status) {
  if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
    return payload.error.slice(0, 500);
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim().slice(0, 500);
  }
  return `Kept API returned HTTP ${status}.`;
}

async function readResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

export class KeptClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new KeptApiError('A Fetch API implementation is required.');
    }
    this.config = config;
    this.fetch = fetchImpl;
    this.sessionToken = config.token || '';
  }

  async login() {
    if (!this.config.username || !this.config.password) {
      throw new KeptApiError('The Kept session expired. Supply a fresh KEPT_TOKEN.');
    }

    let response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'kept-mcp/1.0'
        },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      throw new KeptApiError(`Kept login request failed: ${error.message}`, { code: 'NETWORK_ERROR' });
    }
    const payload = await readResponse(response);
    if (!response.ok) {
      if (payload?.requires2FA) {
        throw new KeptApiError(
          'This Kept account requires 2FA. Sign in interactively and provide the resulting session as KEPT_TOKEN.',
          { status: response.status, code: 'TWO_FACTOR_REQUIRED' }
        );
      }
      throw new KeptApiError(`Kept login failed: ${responseMessage(payload, response.status)}`, {
        status: response.status,
        code: 'LOGIN_FAILED'
      });
    }
    if (!payload?.token) {
      throw new KeptApiError('Kept login succeeded without returning a session token.');
    }
    this.sessionToken = payload.token;
    return this.sessionToken;
  }

  async request(path, { method = 'GET', body, retryAuth = true } = {}) {
    if (!this.sessionToken) await this.login();

    let response;
    try {
      response = await this.fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.sessionToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'kept-mcp/1.0'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      const pathname = new URL(path, this.config.baseUrl).pathname;
      throw new KeptApiError(`${method} ${pathname} failed: ${error.message}`, { code: 'NETWORK_ERROR' });
    }

    const payload = await readResponse(response);
    if (response.status === 401 && retryAuth && this.config.username && this.config.password) {
      this.sessionToken = '';
      await this.login();
      return this.request(path, { method, body, retryAuth: false });
    }
    if (!response.ok) {
      throw new KeptApiError(responseMessage(payload, response.status), {
        status: response.status,
        code: 'API_ERROR'
      });
    }
    return payload;
  }

  listLabels() {
    return this.request('/api/labels');
  }

  async resolveLabels(names) {
    const existing = await this.listLabels();
    const byName = new Map(existing.map((label) => [String(label.name).toLowerCase(), label]));
    const resolved = [];
    const selected = new Set();
    for (const name of names) {
      const key = name.toLowerCase();
      if (selected.has(key)) continue;
      selected.add(key);
      let label = byName.get(key);
      if (!label) {
        label = await this.request('/api/labels/find-or-create', {
          method: 'POST',
          body: { name }
        });
        byName.set(key, label);
      }
      resolved.push({ id: label.id, name: label.name, added: true });
    }
    return resolved;
  }

  searchNotes(query) {
    return this.request(`/api/notes/search?q=${encodeURIComponent(query)}`);
  }

  getNote(noteId) {
    return this.request(`/api/notes/${noteId}`);
  }

  createNote(note) {
    return this.request('/api/notes', { method: 'POST', body: note });
  }

  async updateNote(noteId, changes) {
    await this.request(`/api/notes/${noteId}`, { method: 'PATCH', body: changes });
    return this.getNote(noteId);
  }

  archiveNote(noteId) {
    return this.request(`/api/ai/notes/${noteId}/archive`, { method: 'POST' });
  }

  trashNote(noteId) {
    return this.request(`/api/ai/notes/${noteId}/trash`, { method: 'POST' });
  }
}
