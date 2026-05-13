<div align="center">
  <img src="src/assets/images/keep2x.png" alt="Kept logo" width="96">
  <br>
  <img src="src/assets/images/keep2x_Text.png" alt="Kept" width="180">

# Kept

### Your self-hosted sticky notes — fast, friendly, and yours

</div>

Kept is a notes app for people who love quick, low-friction capture. Jot down a thought, scribble a doodle, run a checklist, save a link, attach a file — all the things a good notes app should make effortless. The catch with most note apps is that your data lives on someone else's server. Kept doesn't. You run it, your data stays put.

If you've been hunting for that *Google Keep feeling* in something self-hosted and kept being disappointed, this is the project for you.

## What it looks like

<img src="src/assets/images/ui-showcase.png" alt="Kept UI showing the sidebar, search, and a grid of colorful note cards including checklists, image notes, link previews, and a drawing">

## Why Kept exists

I've spent years bouncing between open-source note apps trying to find one that felt like Google Keep — quick, colorful, easy to glance at, never in the way. Most are capable but slow, or powerful but fiddly. Kept is the version I wanted: the speed and clean visual feel of Keep, with everything that comes from owning your own data.

## What you get

📝 **All the kinds of notes you actually use** — text, checklists, doodles you draw right in the app, photos, file attachments. Drag checklist items to reorder. Drag note cards to rearrange. Pin the important ones to the top.

🎨 **Make them yours** — colors, background images, custom labels. The app remembers a per-user theme (light or dark), and your avatar can be a photo you upload or a friendly little animal.

🔗 **Smart capture** — paste a URL and it grows a link preview card. Drop in images, attach PDFs or zips up to 25 MB, embed pictures inline in the body text.

🔍 **Find anything fast** — search with simple text, or filter by type (`!image`, `!todo`, `!label:work`) and date queries (`last month`, `this week`). The grid filters live as you type.

⏰ **Reminders that actually fire** — set a one-shot or scheduled reminder, get a browser push notification when it's time. Optional sync with Google Calendar or any CalDAV calendar (your calendar of choice — Apple, Fastmail, Nextcloud, whatever) if you want the events to show up alongside everything else.

📱 **Install it like an app** — Kept supports PWA installs on iOS and Android, including push notifications for reminders. The short setup guide lives on the [Kept website](https://www.keepitkept.xyz/#pwa-mobile).

🤝 **Share notes with people on your instance** — collaborative editing in real time, like a doc editor. Both people typing in the same note see each other's changes live.

🔐 **Privacy by default** — local user accounts, optional two-factor authentication with backup codes, an admin panel for managing users. Your data lives in a single folder on your machine. Nothing is sent anywhere unless you explicitly turn on a calendar integration.

📦 **Coming from Google Keep?** — drop in a Google Takeout zip and Kept imports your notes, labels, colors, drawings, and images.

🔄 **Merge notes** — select a few notes, smush them together into a single combined note. Keeps text, checklists, images, attachments, and reminders all together.

💾 **Backups built in** — automated daily / weekly / monthly snapshots, downloadable as a single file. Restoring later is as easy as uploading that file back.

## Get it running

The easiest path is Docker — it bundles everything up and works the same way everywhere.

You'll need:
- **Docker** (the Docker Engine + Compose plugin, or Docker Desktop on Windows / macOS)
- **Git**, to clone the repo

Then it's three commands:

```bash
git clone https://github.com/ericerkz/kept.git
cd kept
docker compose up -d --build
```

That's it. Open `http://localhost:6767` in your browser, follow the friendly setup wizard to create your admin account, and you're in.

If you need more guidance, refer to the [Kept website](https://www.keepitkept.xyz/#pwa-mobile).

Your notes, uploads, and database all live in a `./data` folder right next to the project. Use Kept's automated backups, or you can back it up by copying that folder anywhere you'd back up the rest of your stuff (cloud sync, external drive, whatever) so long as it's idle/not mid-write. 

<details>
<summary>Want to run it without Docker?</summary>

If you'd rather install Kept directly on your machine, you'll need **Node.js v24.x**. There are scripts that handle the rest for you.

**Linux or macOS:**
```bash
chmod +x install-native.sh
sudo ./install-native.sh
```

**Windows** — open PowerShell as Administrator and run:
```powershell
.\install-native.ps1
```

The scripts install dependencies, build the app, and optionally set up a background service so Kept starts on boot. If Node.js v24.x isn't installed yet, the script will try to install it for you.

If you skip the background-service step, you can start Kept manually with `PORT=6767 npm run api` (or `$env:PORT=6767; npm run api` on Windows).

</details>

<details>
<summary>Want to put Kept behind a domain (with HTTPS)?</summary>

If you want to access Kept from outside your home network, or you want push notifications to work on iPhone (which Apple gates behind real HTTPS), put Kept behind a reverse proxy with a real domain and a TLS certificate.

The easiest free path: point a domain at your server and set up [Caddy](https://caddyserver.com/), [Nginx Proxy Manager](https://nginxproxymanager.com/), or [Traefik](https://traefik.io/) — all of these will fetch and renew Let's Encrypt certificates automatically. Then have the proxy forward your domain to `localhost:6767`.

Realtime online status and live collaboration use WebSockets at `/api/realtime`. If they work on LAN but not through your public domain, your reverse proxy is probably serving normal HTTP but not forwarding WebSocket upgrade requests. Put the `/api/realtime` rule before the catch-all `/` rule.

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

    # WebSocket realtime: online status + live collaboration.
    ProxyPass /api/realtime ws://127.0.0.1:6767/api/realtime
    ProxyPassReverse /api/realtime ws://127.0.0.1:6767/api/realtime

    # Normal app/API traffic.
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

    # WebSocket realtime: online status + live collaboration.
    location /api/realtime {
        proxy_pass http://127.0.0.1:6767/api/realtime;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Normal app/API traffic.
    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Once Kept is on a real `https://` URL, you can install it as a PWA on iOS or Android and get push notifications for reminders. See the [mobile install guide](https://www.keepitkept.xyz/#pwa-mobile) for the short version.

</details>

## Backups & restoring

Your data lives in `./data` — a regular folder. Copy it, sync it, snapshot it however you snapshot anything else. As long as you have that folder, you have your notes.

Kept also has a built-in backup feature that creates clean, consistent SQLite snapshots even while the app is running. As an admin, head to the **User Management** panel and look for the "Database backups" section — schedule daily, weekly, or monthly backups, or hit the button to make one right now. Backups download as a single `.sqlite` file you can stash anywhere.

When the day comes that you need to restore — new server, lost data, whatever — the setup wizard's **"Restore from backup"** option takes that file and recreates everything. Users, notes, labels, settings, all of it.

<details>
<summary>One safety note about restoring</summary>

The restore endpoint is gated by an environment variable so a malicious actor can't use it to take over an empty Kept instance. To restore:

1. Set `KEPT_ALLOW_RESTORE=1` (uncomment in `docker-compose.yml` or export it for native installs).
2. Restart Kept (`docker compose up -d` for Docker).
3. Upload your backup file via the setup screen.
4. Comment out / unset the variable and restart again, so the endpoint is locked back down.

</details>

## Updating

When a new version of Kept is released, admin users see an unobtrusive banner at the top of the app letting them know. To update:

```bash
cd kept
git pull
docker compose up -d --build
```

Your data stays untouched.

## Optional knobs

`docker-compose.yml` has a few environment variables you can uncomment if you need them:

- **`BASE_URL`** — only needed if you're behind a reverse proxy that doesn't forward HTTPS info correctly. Used for OAuth redirect URIs.
- **`KEPT_SESSION_TTL_DAYS`** — how long login sessions last (default 30 days).
- **`KEPT_CORS_ALLOW_ALL` / `KEPT_CORS_ORIGINS`** — Docker defaults to permissive CORS for remote clients/native shells. Use `KEPT_CORS_ORIGINS` if you want to restrict browser API access to specific app origins.
- **`PUID` / `PGID`** — pin the container to a specific Linux user/group. Auto-detected by default.

The compose file has a comment explaining each one.

## Tech under the hood

Kept's frontend is **Angular** with **Sass** styles, and the backend is a single-file **Express** server on **Node.js**. Data lives in a **SQLite** file. No external services required to run it. Web push uses the standard browser APIs.

## Acknowledgement

Kept's original UI scaffolding was forked from [aBrihoum/google-keep-clone](https://github.com/aBrihoum/google-keep-clone). The project has since been substantially rewritten and extended into a full self-hosted notes platform — but the visual foundation came from that earlier work, and the credit is gratefully due.
