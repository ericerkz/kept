const http = require('node:http');
const https = require('node:https');

// SVG must stay usable as an image without becoming an active app-origin document.
// Inline styles and embedded image data preserve self-contained SVG artwork;
// scripts, forms, external loads, and same-origin privileges remain disabled.
const IMAGE_PROXY_CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

function imageProxyResponseHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': IMAGE_PROXY_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  });
  next();
}

function mountImageProxyRoutes(app, { requireAuthOrQueryToken, asyncRoute, publicRequestOptions, absolutizeUrl }) {
  app.get('/api/proxy-image', imageProxyResponseHeaders, requireAuthOrQueryToken, asyncRoute(async (req, res) => {
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
          'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg'
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
}

module.exports = { mountImageProxyRoutes };
