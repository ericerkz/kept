# Kept MCP server

Kept includes a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for connecting trusted AI clients and agents to your Kept account. It works through Kept's authenticated HTTP API and never opens the SQLite database directly.

Agent Access is disabled by default. When enabled, an agent can search and read notes, create and edit all supported note types, manage checklists, images, attachments, reminders, labels, binders, collaborators, pinning, archive, and trash. Locked-note access and permanent note deletion remain disabled unless you turn on their separate settings.

## Enable Agent Access

1. Sign in to Kept and open **Settings**.
2. Find **Agent Access** and enable **Agent access (MCP)**.
3. Copy the generated token immediately. Kept stores only its hash and cannot show the full token again.
4. Add the token and your Kept URL to your MCP client configuration.

Disabling Agent Access immediately revokes its token. **Generate new token** also revokes the previous token. Each Kept user has their own agent settings and token.

## MCP client configuration

The server uses MCP's `stdio` transport. From a Kept source checkout:

```json
{
  "mcpServers": {
    "kept": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/kept", "run", "mcp"],
      "env": {
        "KEPT_BASE_URL": "https://kept.example.com",
        "KEPT_MCP_TOKEN": "${KEPT_MCP_TOKEN}"
      }
    }
  }
}
```

Environment-variable expansion differs by MCP client. Prefer the client's secret store or a wrapper that reads the token from a secret manager instead of placing the token directly in a checked-in configuration file.

The published Kept container can run the same entrypoint:

```bash
docker run --rm -i \
  --env-file /secure/path/kept-mcp.env \
  ghcr.io/ericerkz/kept:latest \
  node mcp/index.mjs
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `KEPT_BASE_URL` | Yes | Kept origin, such as `https://kept.example.com` |
| `KEPT_MCP_TOKEN` | Yes | Dedicated token generated in **Settings > Agent Access** |
| `KEPT_REQUEST_TIMEOUT_MS` | No | HTTP timeout from 100 through 120000 ms; default 10000 |
| `KEPT_CUSTOM_HEADERS_JSON` | No | JSON object of additional reverse-proxy headers, such as Cloudflare Access service-token headers |

For example:

```json
{
  "CF-Access-Client-Id": "client-id",
  "CF-Access-Client-Secret": "client-secret"
}
```

Kept rejects custom `Authorization`, `Cookie`, `Host`, `Content-Length`, `Connection`, and `Accept-Encoding` headers. The adapter also refuses HTTP redirects so it cannot forward credentials to another origin.

## Locked notes

Locked-note content is redacted by default, even when the agent can otherwise see the note. To make it available:

1. Enable **Locked-note access** in Agent Access settings.
2. Ask the agent to request access to the locked note.
3. Open the short-lived Kept URL returned by the agent and enter the note passcode there.

The passcode is submitted directly to your Kept server. It is not returned to the MCP client or model. A successful approval unlocks only that note for that MCP token for five minutes.

## Permanent deletion

Agents can archive, trash, and restore owned notes by default after Agent Access is enabled. They cannot permanently delete a note unless **Permanent note deletion** is also enabled in Agent Access settings. That switch is off by default; while enabled, no additional confirmation is required when the tool is called.

## Available tools

| Area | Tools and capabilities |
| --- | --- |
| Notes | Search, read, create, and update text or rich-text notes |
| Checklists | Create lists; add, edit, complete, indent, reorder, and remove items |
| Drawings and images | Create drawing notes and add, replace, or read note images |
| Organization | Resolve labels, assign labels and binders, change appearance, and pin notes |
| Lifecycle | Archive, trash, restore, and optionally permanently delete owned notes |
| Reminders | List, create, update, dismiss, and delete time, recurring, or location reminders |
| Sharing | Search users and replace collaborators on owned notes |
| Attachments | Upload, read, and delete supported attachments |

Collaborators can edit shared note content and manage their own pin state. Owner-only operations such as changing labels, binders, appearance, lifecycle state, collaborators, deleting attachments, or permanently deleting the note are rejected when the connected user is not the owner.

## Security considerations

Enabling Agent Access grants broad access to the connected user's unlocked Kept data. Only connect MCP clients and models you trust, protect the token like a password, and revoke it when it is no longer needed.

Notes and attachments can contain untrusted instructions. An AI client may treat text inside a note as directions even when it should be treated only as data; this is commonly called prompt injection. Review sensitive or destructive actions and avoid connecting autonomous agents whose behavior you cannot inspect.

MCP tokens cannot access Kept's administration, account settings, backup/restore, sync, or arbitrary action-plan endpoints. Mutating MCP API requests are recorded with user, token, route, result status, and time; note content and filenames are not included in that audit record.

## Development

Run the MCP unit, transport, and real API contract tests:

```bash
npm run test:mcp
```

The adapter targets Kept's application API. Changes to its note, reminder, attachment, sharing, or authentication routes should update the MCP contract tests in the same pull request.

Initial MCP support was contributed by [@asymetryk](https://github.com/asymetryk).
