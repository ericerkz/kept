const HOUR = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function normalizeNotice(value) {
  if (value === null) return null;
  if (!value || !['ending', 'payment_problem'].includes(value.kind) || typeof value.dismissible !== 'boolean') {
    throw new Error('Invalid managed notice.');
  }
  const date = input => {
    if (input == null) return null;
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))) throw new Error('Invalid notice date.');
    return new Date(input).toISOString();
  };
  const endsAt = date(value.endsAt), deletesAt = date(value.deletesAt);
  if (value.kind === 'ending' && !endsAt) throw new Error('An ending notice needs an end date.');
  const action = new URL(value.actionUrl);
  if (!['http:', 'https:'].includes(action.protocol) || action.username || action.password) throw new Error('Invalid notice action URL.');
  return { kind: value.kind, endsAt, deletesAt, dismissible: value.dismissible, actionUrl: action.href };
}

function createManagedNoticePoller({
  managed, url, token, fetchImpl = fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = message => console.warn(message), timeoutMs = 10000
}) {
  const enabled = managed === true && !!String(url || '').trim() && !!String(token || '').trim();
  let notice = null, timer, pending, stopped = false, lastLogAt = -Infinity;

  function schedule() {
    if (stopped || !enabled) return;
    timer = setTimer(() => { timer = undefined; void refresh(); }, notice ? HOUR : 6 * HOUR);
    timer?.unref?.();
  }

  function refresh() {
    if (!enabled || stopped) return Promise.resolve();
    if (pending) return pending;
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    pending = (async () => {
      try {
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('Invalid notice endpoint.');
        // This is an administrator-configured endpoint, not a user-supplied URL.
        // Never forward the monitoring credential through a redirect.
        const response = await fetchImpl(target.href, {
          method: 'GET', headers: { 'X-Kept-Metrics-Token': token }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) throw new Error('Notice endpoint returned an error.');
        const chunks = []; let length = 0;
        for await (const chunk of response.body || []) {
          length += chunk.byteLength;
          if (length > MAX_RESPONSE_BYTES) throw new Error('Notice response is too large.');
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const latest = normalizeNotice(payload.notice);
        if (!stopped) notice = latest;
      } catch {
        if (now() - lastLogAt >= HOUR) {
          lastLogAt = now();
          log('Managed-hosting notice refresh failed; keeping the previous notice.');
        }
      }
    })().finally(() => { pending = undefined; schedule(); });
    return pending;
  }

  return {
    get notice() { return notice; },
    start: refresh,
    refresh,
    stop() { stopped = true; if (timer !== undefined) clearTimer(timer); }
  };
}

module.exports = { createManagedNoticePoller, normalizeNotice };
