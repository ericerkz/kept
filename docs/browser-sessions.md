# Browser sessions

The browser app signs in using an HttpOnly session cookie. Login and SSO
responses contain account metadata and a CSRF token, without a reusable bearer
credential. `gk_session` retains account metadata for the offline workspace;
its `token` field is empty in browser mode. CSRF tokens are held in memory and
cannot authenticate a request on their own.

On upgrade, the app immediately removes an existing browser token from storage.
When online, it exchanges that token once for a cookie session and revokes the
old bearer token. An offline upgrade may require signing in again when the
server becomes available. Existing account metadata and offline notes remain
available while the server is unreachable. Signing out requires a connection
so the server can revoke the session and clear the HttpOnly cookie.

## Deployment

- Serve the browser app and API at the same origin where possible. For a
  separate browser origin within the same site, configure `KEPT_CORS_ORIGINS`
  with the exact SPA origin. Wildcard CORS cannot authorize cookie requests.
  A frontend and API on different sites are incompatible with the `SameSite=Lax`
  session cookie; use a same-origin reverse proxy for that deployment.
- HTTPS responses set `Secure`. Forward `X-Forwarded-Proto` accurately through
  the existing trusted reverse proxy. Plain HTTP continues to work for local
  deployments, without the transport protection provided by HTTPS.
- Keep the data directory persistent and private. The cookie signing secret is
  generated as `browser-session-secret` with mode `0600`; session records are
  stored in the SQLite `browser_sessions` table. Restarts preserve sessions.
  Replacing the secret invalidates browser cookies. A database-only restore to
  a new data directory requires browser users to sign in again.
- Cookie-authenticated writes require `X-CSRF-Token`. Browser WebSockets use
  the cookie and validate `Origin` against `BASE_URL` (or the request origin)
  and the explicit `KEPT_CORS_ORIGINS` allowlist.

## Native and API compatibility

iOS and Android keep the existing bearer login/SSO responses, `gk_session`
credential, and Authorization headers used by API requests, widgets and capture
plugins. They do not need cookies or CSRF headers. MCP and OAuth access tokens
retain their existing authentication rules.

Session credentials are no longer accepted in URLs, including uploaded images,
image proxy requests, backup downloads and realtime connections (Path B).
Native protected images are fetched using Authorization and gateway headers,
then displayed using local blob URLs. Permanent image paths are restored before
saving or syncing a note. Blob URLs are revoked on a native session change.
Proxy thumbnails are rasterized to PNG before displaying a blob URL: blob URLs
do not inherit the proxy response's CSP, so directly exposing an SVG blob would
undo the separate proxy hardening. SVG previews still render as images.
Backups and image downloads also use authenticated HTTP requests. Realtime
connections use the existing origin-checked browser cookie or a native
`authenticate` frame sent in response to `auth-required`; no application access
is registered before authentication. Invalid frames and idle handshakes close
with code 1008. URL credentials are rejected rather than migrated or redirected.

### Coordinated mobile rollout

This change requires matching server and shared UI versions. Build the patched
Angular app, copy the output into each wrapper's `www` assets using its normal
asset-sync workflow, then rebuild and distribute the Android/iOS apps. No Swift
or Kotlin source changes are required by this protocol. This patch does not edit
either native repository or copy assets into them.

Older installed clients still send query credentials and will lose protected
images, backup downloads and realtime connectivity against the patched server.
Updated native realtime clients also need the patched server. Ship both sides
together; there is deliberately no legacy-query fallback. A server-only upgrade
does not update an installed app's bundled UI. Existing bearer tokens remain
usable through Authorization headers; this patch does not revoke previously
leaked tokens, so invalidate exposed sessions separately.

This patch covers browser credential storage (Path A) and session credentials in
URLs (Path B). Native credential storage is unchanged. HttpOnly cookies reduce
reusable credential theft by page scripts; an active XSS can still make requests
as the signed-in browser. The underlying XSS protection remains necessary.

## Verification

Use Node 24:

```sh
npm ci
npm run test:browser-session
npm run build
npx playwright install chromium
npm run test:browser-session:ui
# Optional second engine, useful for Safari/WKWebView compatibility:
npx playwright install webkit
KEPT_TEST_BROWSER=webkit npm run test:browser-session:ui
npm run test:native
npm run test:sync
npm run test:mcp
npm run test:reminders
```

The HTTP tests exercise the real server and SQLite database: cookie flags,
CSRF rejection, restart persistence, SSO completion, 2FA backup codes, session
expiry, logout, password changes, disabled accounts, migration, protected
assets/downloads, and native realtime authentication.

The UI tests run the production bundle in a browser and with emulated iOS and
Android Capacitor platforms. Native modes use a separate API origin and custom
gateway headers. They exercise login, reload, note creation, canvas drawings,
image cards and inline editing, SVG proxy previews, backup downloads, offline
writes, realtime reconnect and logout. Network assertions reject token-bearing
URLs and check native media Authorization/gateway headers.
Browser mode also exercises OAuth consent and recovery from unavailable
session bootstrap. These are protocol and UI tests, not physical-device tests.

## Credit and release note

Thanks to [t-animal](https://github.com/t-animal) for reporting the browser
session-token exposure in GHSA-h25p-jg3w-4px6. Suggested release note:

> Browser sign-in now keeps session credentials in HttpOnly cookies instead
> of local storage, with CSRF protection. Session tokens are no longer placed
> in image, download or realtime URLs. Thanks to t-animal for reporting these
> issues. Update the server and mobile apps together; older mobile versions
> need an update for protected images, backup downloads and realtime.

Keep the advisory's reporter credit when publishing. Reporter credit acknowledges
responsible disclosure and does not imply authorship of the patch.
