# Note HTML security

Kept keeps supported rich-text markup while removing executable note content.
The HTML policy in `shared/note-html-policy.json` describes the tags, attributes,
link schemes, and text styles used by the server and browser. Formatting,
headings, lists, tables, safe links, inline images, and raster canvas drawings
remain supported. Active elements, event handlers, executable URLs, embedded
SVG/MathML, and arbitrary CSS are outside the note format. Application SVG
icons and SVG images loaded through the image proxy are separate from embedded
note markup and continue to use their existing paths.

The server applies `sanitize-html` to title, body, and checkbox HTML on REST and
sync writes, and handles Takeout annotation text and URLs safely. Full notes,
cards, sync snapshots, and historical sync changes are sanitized on read, so
existing database records do not require a destructive migration. Unknown
client metadata and checklist IDs/indentation remain intact. Search text derived
from old records is escaped before being returned.

The shared web app uses DOMPurify before variable HTML reaches raw DOM APIs,
including temporary parsing containers, image URL helpers, previews, search,
editor hydration, and live updates. Temporary parsing uses a document without a
browsing context to avoid prematurely loading private images. Existing offline
notes are filtered when read for display and editing; the patch does not purge
offline notes or pending edits. Editor image controls and link-preview markers
remain available while editing and are removed before saving.

Application HTML also receives a CSP that blocks inline scripts/handlers,
plugin objects, and changes to the document base outside the application
origin. The existing Snackbar script URL remains allowed. Font, style, image,
API and WebSocket behavior retains its existing policy. OAuth consent pages and
the image proxy retain their dedicated response policies. CSP supplements the
sanitization; the security tests also run with CSP removed.

## Compatibility and release

This patch targets Kept's existing 1.8.1 architecture. It preserves native bearer
login, headers, image/download URLs, and API response shapes. Neither the iOS
nor Android repository is edited. Future mobile builds should include the
updated shared web bundle through the existing release process: server filtering
alone cannot repair an older native app's already-cached, unsanitized HTML while
that app is offline. No Kept2 backport is included.

The runtime container must include `shared/`; the Dockerfile copies it beside
`server/`. HTML policy changes should be checked against existing note data and
all supported editing flows, with particular attention to legacy caches and
link-preview/image controls.

## Verification

Use Node 24:

```sh
npm ci
npm run test:note-html
npm run build
npx playwright install chromium webkit
npm run test:note-html:ui
KEPT_TEST_BROWSER=webkit npm run test:note-html:ui
npm run test:native
npm run test:sync
npm run test:mcp
npm run test:reminders
node --test src/app/utils/checkbox-indent.test.ts
```

The HTTP suite covers REST create/update, sync writes, dedicated MCP tokens
calling REST, sharing, Takeout imports, legacy records, cards/search, and
historical sync payloads. It checks that executable content is removed and that
rich markup, client metadata, and checkbox indentation survive.

The UI suite runs the production build in web, iOS, and Android Capacitor modes
with Chromium and WebKit. Native modes use a separate API origin and custom
gateway headers. It covers rich editing, inline-image controls, canvas drawing,
links, images, backup downloads, offline sync, realtime reconnect, search,
live shared updates, logout, and malicious HTML from old network responses and
IndexedDB caches. The latter tests remove CSP and bypass server filtering to
verify the client independently. These are platform contract and browser-engine
tests, not physical-device widget, capture, or push tests.

## Credit and release note

Thanks to [t-animal](https://github.com/t-animal) for reporting the stored note
XSS in GHSA-f48q-rgc9-683x. Keep their reporter credit in the advisory. Suggested
release note:

> Fixed stored cross-site scripting in note previews and editing by sanitizing
> note HTML, imports, live updates, and cached content while retaining supported
> rich-text and drawing features. Thanks to t-animal for reporting the issue.

Coordinate publication with the release containing the patch and updated web
bundle. The HttpOnly-session and SVG-proxy patches address separate findings;
this patch must be included even when those protections are present.
