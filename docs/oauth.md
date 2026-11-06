# Kept OAuth integration

Kept includes an OAuth 2.1 authorization server for third-party applications and integrations. It uses authorization code flow with PKCE S256, short-lived access tokens, rotating refresh tokens, dynamic client registration, protected-resource metadata, and token revocation.

OAuth access is disabled per user until they enable **OAuth app access** in Kept settings. A user signs in to Kept and explicitly approves each authorization request. Applications never receive the user's Kept password or dedicated local MCP token. Local MCP access is a separate setting and does not need to be enabled for OAuth.

After authorization, an application can call `GET /api/oauth/me` to identify the connected Kept user and use the standard supported note routes such as `GET /api/notes`, `GET /api/notes/search`, and the corresponding note, label, reminder, collaborator, image, and attachment routes allowed by its scopes.

## Discovery

Set `BASE_URL` to Kept's public HTTPS origin. OAuth metadata is available at:

```text
https://kept.example.com/.well-known/oauth-authorization-server
https://kept.example.com/.well-known/oauth-protected-resource/api
```

The authorization, token, registration, and revocation endpoint URLs are published in that metadata. Public clients are supported and must use PKCE S256; client secrets are not issued.

## Protected resources

Kept exposes two OAuth protected resources:

| Resource | Purpose |
| --- | --- |
| `https://kept.example.com/api` | Direct Kept API integrations |
| `https://kept.example.com/mcp` | Remote Model Context Protocol clients |

Pass the intended resource in both the authorization and token requests. If an authorization request omits `resource`, Kept defaults to the API resource.

## Scopes

| Scope | Access |
| --- | --- |
| `kept.read` | Search and read accessible notes, labels, reminders, collaborators, images, and attachments |
| `kept.write` | Create or change notes, labels, reminders, collaborators, images, and attachments |

Clients may request either scope or both. API requests made with an insufficient scope return HTTP 403. OAuth tokens cannot access account administration, user management, backups, restore, sync internals, or unrestricted server endpoints.

Locked notes remain redacted unless the user separately enables locked-note access and completes the browser unlock flow. Permanent deletion remains unavailable unless the user separately enables it.

## Dynamic client registration

Clients can register through the `registration_endpoint` from discovery:

```bash
curl -X POST https://kept.example.com/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "My Kept integration",
    "redirect_uris": ["https://integration.example.com/oauth/callback"],
    "token_endpoint_auth_method": "none"
  }'
```

Use the returned `client_id` in the authorization-code flow. Web redirect URIs must use HTTPS, except loopback localhost URIs used during local development. Installed applications may register a private-use callback scheme and must follow the native-app guidance in RFC 8252.

## Client ID Metadata Documents

Clients can also use a public HTTPS metadata URL as their `client_id`, without first registering through `/oauth/register`. Kept advertises this support through `client_id_metadata_document_supported` in discovery. This works across providers, including ChatGPT, Claude, and OpenCode.

The JSON document must identify its own URL exactly in `client_id`, provide a `client_name` and `redirect_uris`, and support public-client authentication (`none`). The consent screen shows the client's domain alongside its name. Redirect URIs must match the document; HTTP loopback callbacks may vary only their port so desktop clients can listen on an available local port. Token exchange remains bound to the exact callback approved for that authorization request.

Metadata must be served directly with HTTP 200 and a JSON content type. Kept blocks private/internal metadata destinations and redirects, limits downloads to 5 KiB and five seconds, and caches successful documents according to their HTTP freshness headers, capped at one hour. Dynamic registration remains available for clients that use it.

## Revocation

Applications should send access or refresh tokens to `/oauth/revoke` when disconnected. Kept also lists authorized apps in **Settings > External Access**, where the user can revoke one connection or disable OAuth app access to revoke all OAuth grants. These actions do not change the separate local MCP token.

OAuth here authorizes access to Kept data. Kept's optional upstream OIDC configuration is separate: it lets users sign in to Kept through an identity provider.
