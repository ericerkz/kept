// How long a request body may take to arrive (issue #185).
//
// Node's requestTimeout is one limit for every request. A long one lets large
// imports finish over slow links, but also lets any client, signed in or not,
// hold a connection open that long by trickling a body. So the server turns
// it off and uses two limits instead:
// - every request must arrive within REQUEST_BODY_MS (Node's own default);
// - the Takeout import, initial restore and encryption removal (all of a
//   note's files in one request), once their route's checks have passed, may
//   take up to LARGE_UPLOAD_MS while data keeps arriving, and are cut off when
//   nothing has arrived for UPLOAD_STALL_MS. Single files (images,
//   attachments; 100 MiB at most) fit in the ordinary limit.
// Headers must still arrive within the server's 60-second headersTimeout.
const REQUEST_BODY_MS = 5 * 60 * 1000;
const LARGE_UPLOAD_MS = 60 * 60 * 1000;
const UPLOAD_STALL_MS = 2 * 60 * 1000;

function createRequestDeadlines({ bodyMs = REQUEST_BODY_MS, uploadMs = LARGE_UPLOAD_MS, stallMs = UPLOAD_STALL_MS } = {}) {
  const active = new WeakMap();

  function stop(req) {
    const timers = active.get(req);
    if (!timers) return;
    clearTimeout(timers.deadline);
    clearInterval(timers.watch);
    req.off('end', timers.done);
    req.socket?.off('close', timers.done);
    active.delete(req);
  }

  // Closes the connection of a request whose body is still arriving. The
  // handler reading it sees an aborted request; req.bodyDeadline says why.
  function cutOff(req, reason) {
    stop(req);
    if (req.complete || req.socket?.destroyed) return;
    req.bodyDeadline = reason;
    req.socket?.destroy();
  }

  // The deadline lasts until the body has arrived, not until the response:
  // a route may answer early (401) while the client keeps sending, and Node
  // keeps reading that unread body on the same connection.
  function track(req, timers) {
    stop(req);
    timers.done = () => stop(req);
    active.set(req, timers);
    req.once('end', timers.done);
    req.socket?.once('close', timers.done);
  }

  // Mounted before everything else: the whole body within bodyMs.
  function requestBodyDeadline(req, _res, next) {
    if (!req.complete) track(req, { deadline: setTimeout(() => cutOff(req, 'request'), bodyMs) });
    next();
  }

  // Called by a large-upload route after its checks: up to uploadMs, as long
  // as data keeps arriving. Usable as middleware or called directly.
  function allowLargeUpload(req, _res, next) {
    if (!req.complete) {
      let lastBytes = Number(req.socket?.bytesRead) || 0;
      let lastProgressAt = Date.now();
      track(req, {
        deadline: setTimeout(() => cutOff(req, 'upload'), uploadMs),
        watch: setInterval(() => {
          const bytes = Number(req.socket?.bytesRead) || 0;
          if (bytes !== lastBytes) {
            lastBytes = bytes;
            lastProgressAt = Date.now();
          } else if (Date.now() - lastProgressAt >= stallMs) {
            cutOff(req, 'stalled');
          }
        }, Math.max(25, Math.min(5000, Math.floor(stallMs / 4))))
      });
    }
    if (next) next();
  }

  return { requestBodyDeadline, allowLargeUpload, limits: { bodyMs, uploadMs, stallMs } };
}

module.exports = { createRequestDeadlines, REQUEST_BODY_MS, LARGE_UPLOAD_MS, UPLOAD_STALL_MS };
