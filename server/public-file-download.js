const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { isPublicAddress } = require('./integration-requests');

// Downloads are independent of the Kept API connection: no session, proxy
// credentials, private-origin exceptions, or pooled sockets are inherited.
function createPublicFileDownloader({ lookup = (host, options) => dns.promises.lookup(host, options), request = https.request } = {}) {
  return async function download(rawUrl, { maxBytes, timeoutMs = 10000, maxRedirects = 3, accept = '*/*', requiredStatus, includeHeaders = false }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('File download timed out.')), timeoutMs);
    const interrupted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    // Every race below observes this rejection, including when DNS never answers.
    interrupted.catch(() => {});
    try {
      let target = rawUrl;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        let url;
        try { url = new URL(target); } catch { throw new Error('The file download URL is invalid.'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('File download URLs must use HTTPS without credentials or fragments.');
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const family = net.isIP(host);
        const addresses = family ? [{ address: host, family }]
          : await Promise.race([lookup(host, { all: true, verbatim: true }), interrupted]);
        if (!addresses.length || addresses.some(value => !isPublicAddress(value.address))) throw new Error('File download URL resolves to a private or reserved network address.');
        const selected = addresses.find(value => net.isIP(value.address) === 4) || addresses[0];
        const response = await Promise.race([new Promise((resolve, reject) => {
          const req = request(url, {
            method: 'GET', agent: false, signal: controller.signal,
            headers: { Accept: accept },
            // Keep the original URL/hostname for Host, SNI and certificate checks.
            lookup: (_host, options, callback) => {
              const done = typeof options === 'function' ? options : callback;
              if (options?.all) done(null, [{ address: selected.address, family: net.isIP(selected.address) }]);
              else done(null, selected.address, net.isIP(selected.address));
            }
          }, resolve);
          req.on('error', reject);
          req.end();
        }), interrupted]);
        try {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            if (hop === maxRedirects || !response.headers.location) throw new Error('Too many redirects while downloading the selected file.');
            target = new URL(response.headers.location, url).href;
            continue;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Could not download the selected file (HTTP ${response.statusCode}).`);
          if (requiredStatus !== undefined && response.statusCode !== requiredStatus) throw new Error(`Unexpected download status (HTTP ${response.statusCode}).`);
          if (Number(response.headers['content-length'] || 0) > maxBytes) throw new Error('The selected file is too large for Kept.');
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > maxBytes) throw new Error('The selected file is too large for Kept.');
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks, size);
          return includeHeaders ? { body, headers: response.headers } : body;
        } finally { response.destroy(); }
      }
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

module.exports = { createPublicFileDownloader };
