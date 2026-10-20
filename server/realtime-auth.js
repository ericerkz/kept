// Authenticate before registering presence or accepting application messages.
// Native clients send their bearer credential in a frame, never in the URL.
async function authenticateRealtime(socket, req, { browserSessions, resolveSessionFromToken, timeoutMs = 5000 }) {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('token')) {
    socket.close(1008, 'Credentials in URLs are not supported.');
    return null;
  }
  const cookieToken = await browserSessions.realtimeToken(req);
  const cookieSession = cookieToken ? await resolveSessionFromToken(cookieToken) : null;
  if (socket.readyState !== 1) return null;
  if (cookieSession) return cookieSession;

  return new Promise(resolve => {
    let settled = false;
    const finish = session => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      if (!session && socket.readyState === 1) socket.close(1008, 'Authentication required.');
      resolve(socket.readyState === 1 ? session : null);
    };
    const onClose = () => finish(null);
    const onMessage = async (data, binary) => {
      // Ignore further frames while checking the first credential. They must
      // never reach the application handler before authentication completes.
      socket.off('message', onMessage);
      try {
        if (binary || data.length > 4096) return finish(null);
        const message = JSON.parse(data.toString());
        if (message.type !== 'authenticate' || typeof message.token !== 'string' || !message.token) return finish(null);
        finish(await resolveSessionFromToken(message.token));
      } catch { finish(null); }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once('close', onClose);
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'auth-required' }));
  });
}

module.exports = { authenticateRealtime };
