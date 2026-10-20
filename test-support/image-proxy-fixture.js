const http = require('node:http');
const express = require('express');
const { mountImageProxyRoutes } = require('../server/image-proxy');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="window.proxyOnloadRan = true">
  <style>.drawing { fill: rgb(255, 0, 0); }</style>
  <rect class="drawing" width="20" height="20"/>
  <script>window.proxyScriptRan = true; window.proxyStorage = localStorage.getItem('gk_session'); fetch('/probe');</script>
</svg>`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');

async function startImageProxyFixture() {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/drawing.svg' }); return res.end(); }
    if (req.url === '/error') { res.writeHead(503); return res.end('Unavailable'); }
    if (req.url === '/html') { res.setHeader('Content-Type', 'text/html'); return res.end('<script>window.proxyScriptRan = true</script>'); }
    if (req.url === '/pixel.png') { res.setHeader('Content-Type', 'image/png'); return res.end(png); }
    res.setHeader('Content-Type', req.url === '/mixed-case.svg' ? 'Image/SVG+XML; charset=utf-8' : 'image/svg+xml');
    // These untrusted upstream headers must never replace our response policy.
    res.setHeader('Content-Security-Policy', "script-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(svg);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = express();
  let probes = 0;
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><title>Kept proxy fixture</title>'));
  app.get('/probe', (_req, res) => { probes++; res.end(); });
  mountImageProxyRoutes(app, {
    requireAuthOrQueryToken: (req, res, next) => req.query.token === 'attacker-test-token' || req.get('Authorization') === 'Bearer attacker-test-token' ? next() : res.status(401).end(),
    asyncRoute: handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next),
    publicRequestOptions: async (url, options) => {
      if (new URL(url).hostname !== 'images.example.test') throw new Error('Blocked target');
      return { ...options, hostname: '127.0.0.1', port: upstream.address().port };
    },
    absolutizeUrl: (url, base) => new URL(url, base).href
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, svg, png, get probes() { return probes; },
    proxyUrl: (path = '/drawing.svg') => `${baseUrl}/api/proxy-image?token=attacker-test-token&url=${encodeURIComponent(`http://images.example.test${path}`)}`,
    async close() {
      await Promise.all([server, upstream].map(instance => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); })));
    }
  };
}
module.exports = { startImageProxyFixture };
