<div align="center">
  <img src="src/assets/images/keep2x.png" alt="Kept logo" width="96">
  <br>
  <img src="src/assets/images/keep2x_Text.png" alt="Kept" width="180">

# Kept

### Self-hosted notes with a Google Keep-style feel

</div>

Kept is a self-hosted notes app built for quick capture: text notes, checklists, images, drawings, links, attachments, labels, colors, and reminders. It aims to keep the lightweight feel of Google Keep while storing your data on your own server.

> **Kept 2 preview branch:** this `kept2` branch contains unreleased local-first and encrypted-sync work. It is intended for testing and development, not as the stable production branch yet. The current stable self-hosted release remains the published Docker image and the default branch.

<p>
  <a href="https://apps.apple.com/ca/app/kept-notes/id6768974473">
    <img src="https://img.shields.io/badge/App%20Store-Kept%20Notes-000000?logo=apple&logoColor=white" alt="Download Kept Notes on the App Store">
  </a>
  <a href="https://play.google.com/store/apps/details?id=xyz.keepitkept.app">
    <img src="https://img.shields.io/badge/Google%20Play-Kept%20Notes-000000?logo=googleplay&logoColor=white" alt="Get Kept Notes on Google Play">
  </a>
  <a href="https://ko-fi.com/kept_notes">
    <img src="https://img.shields.io/badge/Ko--fi-Support%20Me-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi">
  </a>
</p>

<p>
  <a href="https://railway.com/deploy/kept-notes">
    <img src="https://railway.com/button.svg" alt="Deploy on Railway">
  </a>
</p>

## Screenshot

<img src="src/assets/images/ui-showcase.png" alt="Kept UI showing the sidebar, search, and a grid of colorful note cards">

## Why Kept Exists

I wanted something that felt like Google Keep: fast, colorful, easy to glance at, and never too heavy for a quick thought. Most self-hosted notes apps I tried were either powerful but fiddly, or simple but missing the feel I wanted. Kept is my attempt at replicating the simplicity of Google Keep, while keeping the data on a server you control.

## Features

- Text notes, checklists, image notes, drawings, links, and file attachments.
- Drag-and-drop note ordering and checklist item ordering.
- Labels, binders, colors, background images, pinned notes, archive, and trash.
- Search and filters, including note type, labels, and date-style queries.
- Link previews and inline images.
- Time reminders with browser push notifications.
- Location-based reminders through the native iOS and Android apps.
- Quick share to Kept from the native iOS and Android share sheets.
- Android home screen widgets for recent notes, pinned notes, specific labels/binders, quick note creation, and a single selected note.
- Real-time collaborative sharing of notes between users on the same instance.
- Offline note viewing/editing with automatic sync when the client reconnects.
- Google Keep Takeout data import.
- Built-in database backups and restore flow.
- Local user accounts, optional 2FA, and user management.
- Local and remote MCP server options for authenticated agent access without direct database access.
- OAuth 2.1 access for scoped third-party API integrations and remote MCP clients.
- Optional OpenID Connect (OIDC) single sign-on alongside Kept's local accounts.
- Kept 2 preview: password-unlocked local vaults, SQLite-backed local-first storage, encrypted sync, device pairing, recovery codes, and encrypted hosted integration grants.

## Kept 2 Preview

The `kept2` branch is the in-progress next-generation architecture branch. It keeps the existing Kept app available while adding a separate local vault flow at `/kept2/vault`.

What is currently present in this branch:

- A password-unlocked local vault on each device.
- SQLite-backed local storage in the app, with a durable outbox for edits made while offline or on poor connections.
- Local-first note, reminder, label, binder, attachment, and blob paths using stable sync IDs instead of server-generated numeric IDs.
- Encrypted `/api/v2` sync relay endpoints for resources and blobs. The server stores encrypted envelopes and content-blind change notifications.
- Last-write-wins convergence, idempotent mutation receipts, and after-commit realtime notifications.
- Vault key material, recovery codes, password rewrap, device registration, QR/device pairing, and device grant revocation.
- Non-destructive migration/export paths from the current 1.x data model into a Kept 2 vault.
- OPAQUE account-authentication foundations for synced password accounts.
- Hosted integration controls for encrypted-vault remote MCP and hosted calendar access. These integrations are off by default, receive explicit encrypted grants, and exclude locked notes.
- Native-facing paths for local-first reminders, share intents, Smart Capture, and fresh-device recovery validation.

What is still being validated before release:

- Real Android and iOS device testing across vault unlock, recovery, widgets, reminders, share intents, deep links, and native SQLite paths.
- Multi-device sync burn-in with real devices and poor-network/offline scenarios.
- Migration validation against real existing Kept data.
- Hosted encrypted integration and Cloud deployment testing.

To test this branch locally:

```bash
git clone https://github.com/ericerkz/kept.git
cd kept
git checkout kept2
npm install
npm run start
```

Then sign in normally and open `http://localhost:6767/kept2/vault`. Create a vault password and save the recovery code. This password unlocks the local vault; Kept 2.0 should not be treated as a promise of full device-level SQLite at-rest encryption.

The Kept 2 automated gate can be run with:

```bash
npm run test:kept2
```

## Install With Docker

Requirements:

- Docker with Compose
- Git

Kept's recommended stable install path is to use the published Docker image: `ghcr.io/ericerkz/kept:latest`.

```bash
git clone https://github.com/ericerkz/kept.git
cd kept
docker compose up -d
```

Open `http://localhost:6767` and create the first admin account.

Kept stores its database, uploads, attachments, and generated server data in `./data`. Back that folder up if you are not using the built-in backup tools.

If you are testing the unreleased Kept 2 branch, build from the checked-out `kept2` source instead of relying on the `latest` image:

```bash
git checkout kept2
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Easy Hosted Setup

If you do not want to set up Docker or manage a server yourself, Railway can create a ready-to-use Kept instance for you in a few clicks.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/kept-notes)

Railway handles the technical setup:

- Runs Kept for you
- Keeps storage attached for your notes and attachments
- Sets the required configuration
- Gives you a public HTTPS link to open in your browser

Once deployment finishes, open the link Railway gives you and create your first Kept account.

Railway is one convenient way to deploy Kept quickly. Kept remains self-hostable on any platform that supports Docker.

## Native iOS App

[Kept Notes is available on the App Store](https://apps.apple.com/ca/app/kept-notes/id6768974473). It connects to your self-hosted Kept server and adds native iPhone/iPad integration:

- Apple Reminders support.
- Location reminders with arrival/departure settings, and the ability to save locations
- Quick share into Kept from the iOS share sheet.
- On-device Smart Capture using Apple Intelligence.
- A native app shell around your Kept instance.

## Native Android App

[Kept Notes is available on Google Play](https://play.google.com/store/apps/details?id=xyz.keepitkept.app). It connects to your self-hosted Kept server and adds native Android integration:

- Location reminders with arrival/departure settings, background geofencing, and saved places.
- Quick share into Kept from the Android share sheet.
- Home screen widgets for recent notes, pinned notes, filtered labels/binders, quick note creation, and a single selected note.
- On-device Smart Capture using Android's native Gemini Nano when available, or Kept's local Gemma fallback model on Android devices that need it.
- A native app shell around your Kept instance.

## PWA / Mobile Browser

The Kept web app can also be installed as a PWA on iOS and Android. For push notifications and reliable mobile installs, Kept needs to be served from a secure `https://` URL. Location-based reminders require the native iOS or Android app.

The short setup guide is on the [Kept website](https://www.keepitkept.xyz/#pwa-mobile).

## Reverse Proxy / HTTPS

Use HTTPS if you want public access, PWA installs, OAuth redirects, or push notifications. Point your proxy at `127.0.0.1:6767`.

Realtime presence and collaborative editing use WebSockets at `/api/realtime`, so proxy that path with WebSocket upgrade support.

Apache example:

```apache
# Required once:
# sudo a2enmod proxy proxy_http proxy_wstunnel rewrite ssl
# sudo systemctl reload apache2

<VirtualHost *:80>
    ServerName kept.example.com
    Redirect permanent / https://kept.example.com/
</VirtualHost>

<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName kept.example.com
    ProxyRequests Off
    ProxyPreserveHost On

    ProxyPass /api/realtime ws://127.0.0.1:6767/api/realtime
    ProxyPassReverse /api/realtime ws://127.0.0.1:6767/api/realtime

    ProxyPass / http://127.0.0.1:6767/
    ProxyPassReverse / http://127.0.0.1:6767/

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/kept.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/kept.example.com/privkey.pem
</VirtualHost>
</IfModule>
```

Nginx example:

```nginx
server {
    listen 80;
    server_name kept.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name kept.example.com;

    ssl_certificate /etc/letsencrypt/live/kept.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kept.example.com/privkey.pem;

    location /api/realtime {
        proxy_pass http://127.0.0.1:6767/api/realtime;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Advanced config

#### VPN/Tailscale/WireGuard setups

If you access Kept through Tailscale, WireGuard, another VPN, a LAN hostname/IP, or more than one reverse-proxy domain, the CORS settings may be relevant. These setups do not require special CORS settings by themselves; CORS only matters when the browser page and Kept API are reached through different origins, or when you restrict origins with `KEPT_CORS_ORIGINS`. If you use `KEPT_CORS_ORIGINS`, include each exact browser origin you use, such as your Tailnet name, VPN-only domain, LAN IP, or public reverse-proxy domain, including the scheme and port when applicable. For the simplest personal setup, leave `KEPT_CORS_ALLOW_ALL=1` enabled instead. Same-origin access does not need extra CORS configuration.

#### Custom header support in the mobile apps

The native iOS and Android apps support optional custom connection headers for reverse proxies or access gateways that require them, such as Cloudflare Access service tokens or shared-secret proxy headers. Configure these only if your proxy setup requires them.

Custom headers help the mobile apps pass normal Kept HTTP requests through a header-auth gateway, including login, loading notes, saving notes, attachments, and settings. They are not a replacement for Kept login; users still need a Kept account/session.

Custom headers do not apply to realtime WebSocket connections. Realtime presence and live collaboration use WebSockets at `/api/realtime`, and browser/WebView WebSockets cannot attach arbitrary custom headers. Behind gateways that require header auth on WebSocket upgrade requests, normal reads/writes should still work, but live updates may only appear after refocusing the app or manually refreshing.

#### OpenID Connect single sign-on

Kept can use an OpenID Connect provider for optional single sign-on while keeping normal username/password login available. Set `BASE_URL`, `KEPT_OIDC_ISSUER`, and `KEPT_OIDC_CLIENT_ID`; confidential clients should also set `KEPT_OIDC_CLIENT_SECRET`. Every user first needs a local Kept account and must sign in locally once, then choose **Connect SSO account** in Settings. Kept does not automatically create or email-match accounts from OIDC identities.

The callback URL to register with your identity provider is `https://your-kept.example/api/auth/oidc/callback`. OIDC sign-in is an additional authentication path, not a replacement for Kept's own authorization rules. See the [OIDC setup guide](docs/oidc.md) for configuration and account-linking details.



## Backups And Restore

Kept can create consistent SQLite backups while the app is running. Admin users can schedule daily, weekly, or monthly backups from User Management, or create one manually.

To restore from a backup during setup:

1. Set `KEPT_ALLOW_RESTORE=1`.
2. Restart Kept.
3. Upload the backup file from the setup screen.
4. Remove `KEPT_ALLOW_RESTORE` and restart again.

The restore flag is intentionally opt-in so the restore endpoint is not left open on a public instance.

## Updating

```bash
cd kept
docker compose pull
docker compose up -d
```

Your `./data` folder is not replaced by updates.

## Configuration

Useful environment variables are documented in `docker-compose.yml`. The common ones are:

- `BASE_URL`: public origin used for OAuth/callback generation. Required for remote MCP/OAuth and OIDC.
- `KEPT_OIDC_ISSUER` / `KEPT_OIDC_CLIENT_ID` / `KEPT_OIDC_CLIENT_SECRET`: optional upstream OIDC single sign-on provider.
- `KEPT_OIDC_NAME`: label shown on the sign-in button. Defaults to `Single sign-on`.
- `KEPT_OIDC_SCOPES`: scopes requested from the provider. Defaults to `openid profile email`.
- `KEPT_SESSION_TTL_DAYS`: login session lifetime. Defaults to 30 days.
- `KEPT_CORS_ALLOW_ALL` / `KEPT_CORS_ORIGINS`: CORS behavior for remote clients and native shells. Native app WebView origins are allowed automatically when using `KEPT_CORS_ORIGINS`.
- `KEPT_TAKEOUT_UPLOAD_MAX`: Google Takeout ZIP upload cap. Defaults to `5GB`; only affects Takeout imports.
- `PUID` / `PGID`: run the container as a specific Linux user/group.
- `KEPT_ALLOW_RESTORE`: temporarily enables restore from backup during setup.
- `VAPID_SUBJECT`: optional public URL/contact identity for web push. Kept auto-generates VAPID keys if you do not set them; only set this if push notifications need a more explicit public origin.
- `KEPT2_BLOB_UPLOAD_MAX`: optional upload cap for encrypted Kept 2 blob sync. Defaults to 250 MB.
- `KEPT2_OPAQUE_SERVER_SETUP`: optional fixed OPAQUE server setup for deployments that need deterministic server key material across rebuilds. If omitted, Kept stores generated setup in the app database.
- `KEPT2_REMOTE_MCP_PUBLIC_KEY`: public key for the encrypted hosted/remote MCP worker. Required only when testing Kept 2 encrypted-vault remote MCP grants.
- `KEPT2_HOSTED_CALENDAR_PUBLIC_KEY`: public key for encrypted hosted calendar workers. Required only when testing Kept 2 hosted calendar grants.

## OAuth, MCP, And External Access

Kept includes an optional OAuth 2.1 authorization server for third-party apps and integrations. OAuth clients can request read-only or read/write access to the supported Kept API without receiving a user's password or long-lived local MCP token. See [the OAuth integration guide](docs/oauth.md).

Remote MCP is one consumer of that OAuth layer. Local MCP clients can use stdio with a dedicated token; remote clients such as ChatGPT can connect to the Streamable HTTP endpoint at `/mcp`. OAuth app access and local MCP access are independent, off-by-default settings, so either can be enabled or revoked without affecting the other. Locked notes and permanent deletion have separate shared opt-in controls. See [the MCP setup and security guide](docs/mcp.md).

In Kept 2 encrypted vaults, remote MCP is still supported but it works through explicit encrypted grants rather than broad server-side plaintext access. Turning remote MCP off revokes future service access and existing grants, but it does not rotate or re-encrypt every affected note key in the current preview.

## Development

Kept is an Angular app with a Node/Express backend and SQLite storage.

```bash
npm install
npm run start
```

Useful scripts:

- `npm run build`
- `npm run test:sync`
- `npm run api`
- `npm run client`

## Build It Yourself

If you want to build from the local source instead of pulling the published image, use the dev compose override:

```bash
git clone https://github.com/ericerkz/kept.git
cd kept
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Acknowledgement

Kept's original UI scaffolding was forked from [aBrihoum/google-keep-clone](https://github.com/aBrihoum/google-keep-clone). The project has since been substantially rewritten and extended into a full self-hosted notes platform — but the visual foundation came from that earlier work, and the credit is gratefully due.
