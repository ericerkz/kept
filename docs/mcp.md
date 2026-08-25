# Kept MCP server

Kept includes a local Model Context Protocol server that lets MCP-compatible agents search, read, create, update, archive, and trash notes through Kept's authenticated HTTP API. It never opens the SQLite database directly.

The server uses the MCP `stdio` transport. The MCP client starts it as a child process, so the only network connection is from the child process to the configured Kept instance.

## Requirements

- Node.js 24
- A reachable Kept instance
- A dedicated, non-admin Kept user for agent access

## Authentication

Configure one of these modes:

1. `KEPT_TOKEN`: an existing Kept session token. This is required for accounts with 2FA.
2. `KEPT_USERNAME` and `KEPT_PASSWORD`: the server signs in on startup and retries once after an expired session. This mode is intended for a dedicated agent user without 2FA.

Kept session tokens expire after `KEPT_SESSION_TTL_DAYS`, which defaults to 30 days. Treat session tokens and passwords as secrets. Inject them from your MCP client's secret store or another approved secret manager instead of committing them to a configuration file.

| Variable | Required | Purpose |
| --- | --- | --- |
| `KEPT_BASE_URL` | Yes | Kept origin, such as `https://kept.example.com` |
| `KEPT_TOKEN` | One auth mode | Existing Kept session token |
| `KEPT_USERNAME` | One auth mode | Dedicated Kept username |
| `KEPT_PASSWORD` | One auth mode | Dedicated Kept password |
| `KEPT_REQUEST_TIMEOUT_MS` | No | HTTP timeout from 100 through 120000 ms; default 10000 |

## MCP client configuration

From a Kept source checkout:

```json
{
  "mcpServers": {
    "kept": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/kept", "run", "mcp"],
      "env": {
        "KEPT_BASE_URL": "https://kept.example.com",
        "KEPT_TOKEN": "${KEPT_TOKEN}"
      }
    }
  }
}
```

The exact environment-variable expansion syntax depends on the MCP client. If the client does not support secret expansion, use a wrapper that reads the token from a secret manager and then starts `node /absolute/path/to/kept/mcp/index.mjs`.

The published Kept container can run the same entrypoint:

```bash
docker run --rm -i \
  --env-file /secure/path/kept-mcp.env \
  ghcr.io/ericerkz/kept:latest \
  node mcp/index.mjs
```

## Tools

| Tool | Effect |
| --- | --- |
| `kept_search_notes` | Search visible notes; returns at most 20 summaries |
| `kept_get_note` | Read one visible note by id |
| `kept_list_labels` | List labels owned by the authenticated user |
| `kept_create_note` | Create a text note with optional binder, labels, and pin |
| `kept_update_note` | Update selected title, body, binder, labels, or pin fields |
| `kept_archive_note` | Archive an owned note |
| `kept_trash_note` | Move an owned note to Kept's recoverable trash |

Permanent deletion, user administration, backup restoration, arbitrary action-plan execution, and direct database access are intentionally not exposed.

## Development

Run the focused MCP tests:

```bash
npm run test:mcp
```

The adapter targets Kept's existing authenticated application API. That API is not independently versioned, so changes to Kept note or authentication routes should update these contract tests in the same pull request.
