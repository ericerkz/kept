function createRequestLimits({ now = Date.now } = {}) {
  const buckets = new Map();
  function rateLimit({ windowMs, max, key, perUser = false }) {
    return (req, res, next) => {
      // Account limits run after authentication, so several devices share an
      // allowance without penalizing other accounts behind the same proxy.
      const identity = perUser ? `user:${req.user.id}` : `ip:${req.ip}`;
      const bucketKey = `${key}:${identity}`, time = now();
      let bucket = buckets.get(bucketKey);
      if (!bucket || bucket.resetAt <= time) {
        bucket = { count: 0, resetAt: time + windowMs };
        buckets.set(bucketKey, bucket);
      }
      if (++bucket.count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - time) / 1000))));
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
      }
      next();
    };
  }
  function prune() {
    const time = now();
    for (const [key, value] of buckets) if (value.resetAt <= time) buckets.delete(key);
  }
  return { rateLimit, prune };
}

function createExclusiveTask(message) {
  let active = false;
  return async (handler, req, res) => {
    if (active) return res.status(409).json({ error: message });
    active = true;
    try { await handler(req, res); }
    finally { active = false; }
  };
}

module.exports = { createRequestLimits, createExclusiveTask };
