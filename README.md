# @anima-labs/mcp

MCP (Model Context Protocol) server for Anima -- 54 tools across 9 categories for AI agent communication, identity, and security.

## Hosted vs local (which one do I want?)

Anima runs a **hosted MCP gateway** at `https://mcp.useanima.sh/mcp` -- nothing to install, always current, and it carries the fullest tool surface (it adds inbox management and other tools beyond this package's 54). If your client speaks remote MCP (Cursor, VS Code, Claude Code `--transport http`), point it there with `Authorization: Bearer ak_...` and you're done. See the [MCP docs](https://docs.useanima.sh/mcp-servers).

This npm package is the **stdio bridge** for clients without remote-MCP support and for pinned/air-gapped configs. Same platform, same auth, smaller tool set.

```bash
anima setup-mcp install --all            # hosted gateway (default)
anima setup-mcp install --all --mode stdio  # this package
```

## Installation

```bash
npm install @anima-labs/mcp
# or
bun add @anima-labs/mcp
```

## Quick Start

```bash
# stdio mode (default -- for Claude Desktop, Cursor, Windsurf, etc.)
npx @anima-labs/mcp

# HTTP mode (for web integrations)
npx @anima-labs/mcp --http --port=8014

# Selective tool loading (only register specific groups)
npx @anima-labs/mcp --tools=email,vault,phone
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANIMA_API_URL` | No | API server URL (default: `https://api.useanima.sh`) |
| `ANIMA_API_KEY` | Yes | Agent API key (`ak_` prefix) |
| `ANIMA_MASTER_KEY` | No | Master key (`mk_` prefix) for admin tools |

## Selective Tool Loading

Use the `--tools` flag to load only the tool groups you need. This reduces the tool count exposed to the LLM, which can improve tool selection accuracy and reduce token usage.

```bash
npx @anima-labs/mcp --tools=email,vault,phone
```

Available tool groups:

| Group | Description |
|-------|-------------|
| `workspace` | Account overview and usage rollups |
| `agent` | Agent CRUD and address/identity management |
| `email` | Email send/receive, threads, drafts, attachments |
| `domain` | Custom sending domains: DNS, verification, zone files |
| `phone` | Phone number provisioning and release |
| `phone_call` | Outbound calls, transcripts, recordings, voices |
| `sms` | SMS/MMS send and conversation history |
| `vault` | Credential vault management and TOTP |
| `webhook` | Webhook subscription management and testing |

If `--tools` is not provided, all groups are registered (current default behavior).

## HTTP Mode

Run the MCP server over HTTP instead of stdio for web integrations:

```bash
npx @anima-labs/mcp --http --port=8014
```

The server listens at `http://localhost:8014/mcp` and expects a `Bearer <api-key>` authorization header on each request.

## Configuration Templates

### Claude Desktop

`~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anima": {
      "command": "npx",
      "args": ["-y", "@anima-labs/mcp"],
      "env": { "ANIMA_API_KEY": "ak_..." }
    }
  }
}
```

With selective loading:

```json
{
  "mcpServers": {
    "anima": {
      "command": "npx",
      "args": ["-y", "@anima-labs/mcp", "--tools=email,vault,phone"],
      "env": { "ANIMA_API_KEY": "ak_..." }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "anima": {
      "command": "npx",
      "args": ["-y", "@anima-labs/mcp"],
      "env": { "ANIMA_API_KEY": "ak_..." }
    }
  }
}
```

### Windsurf

`.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "anima": {
      "command": "npx",
      "args": ["-y", "@anima-labs/mcp"],
      "env": { "ANIMA_API_KEY": "ak_..." }
    }
  }
}
```

## Tool Reference

### Workspace (2 tools)

| Tool | Description |
|------|-------------|
| `account_overview` | Single-call workspace snapshot: context, send-capability flags, inventory counts, and blockers |
| `usage_overview` | Usage rollup for a billing period |

### Agent (5 tools)

| Tool | Description |
|------|-------------|
| `agent_create` | Create a new agent, optionally with metadata and an initial address |
| `agent_get` | Get full detail for an agent: settings, metadata, status, addresses, and identities |
| `agent_list` | List agents in the current account context with cursor pagination |
| `agent_update` | Update an agent's name or metadata, and add/update/delete an address |
| `agent_delete` | Delete an agent by ID |

### Email (13 tools)

| Tool | Description |
|------|-------------|
| `email_send` | Send a new outbound email from the agent mailbox |
| `email_get` | Get full detail for a single email by ID, including metadata and body |
| `email_list` | List emails newest-first with cursor pagination, optionally scoped to one agent |
| `email_search` | Search email by meaning (semantic vector search) or literal keyword |
| `email_reply` | Reply to an existing email thread with correct threading headers |
| `email_forward` | Forward an existing email to another recipient |
| `email_thread_get` | Fetch all messages in one or more email threads |
| `email_attachment_get` | Get a temporary download URL for an email attachment |
| `email_draft_create` | Create a new email draft (composed but not sent) |
| `email_draft_get` | Get full detail for a single draft by ID |
| `email_draft_list` | List email drafts with optional filters |
| `email_draft_send` | Send a draft |
| `email_draft_delete` | Discard a draft |

### Domain (7 tools)

| Tool | Description |
|------|-------------|
| `domain_create` | Register a custom sending domain in the workspace |
| `domain_verify` | Trigger a verification check after DNS records are configured |
| `domain_get` | Get full detail for a domain, including verification and config state |
| `domain_list` | List all domains connected to the current workspace |
| `domain_update` | Update mutable configuration on a domain |
| `domain_delete` | Delete a domain from the workspace |
| `domain_zone_file` | Get the full DNS zone file for a domain |

### Phone (3 tools)

| Tool | Description |
|------|-------------|
| `phone_number_list` | List provisioned phone numbers, optionally filtered by agent |
| `phone_number_provision` | Provision a new phone number and assign it to an agent |
| `phone_number_release` | Release a provisioned phone number back to the carrier pool |

### Phone Call (6 tools)

| Tool | Description |
|------|-------------|
| `phone_call_create` | Initiate an outbound phone call from an agent (returns a callId immediately) |
| `phone_call_list` | List phone calls with optional filters |
| `phone_call_get` | Get full detail for a call: status, duration, participants, AI summary, and quality score |
| `phone_call_transcript_get` | Get the full transcript with speaker labels, timestamps, and confidence scores |
| `phone_call_recording_get` | Get a time-limited download URL for a call recording (WAV) |
| `voice_list` | List available AI voices for placing phone calls |

### SMS (5 tools)

| Tool | Description |
|------|-------------|
| `sms_send` | Send an SMS, or an MMS by passing `mediaUrls` |
| `sms_get` | Get full detail for a single SMS by ID (includes its `threadId`) |
| `sms_list` | List SMS messages with optional filters |
| `sms_thread_list` | List SMS conversations |
| `sms_thread_get` | Get a specific SMS conversation with message history |

### Vault (8 tools)

| Tool | Description |
|------|-------------|
| `vault_provision` | Provision a credential vault for an agent |
| `vault_credential_list` | List credentials in an agent vault with optional type filter |
| `vault_credential_get` | Get a single vault credential by ID |
| `vault_credential_create` | Create a new credential in an agent vault |
| `vault_credential_update` | Update an existing vault credential by ID |
| `vault_credential_delete` | Delete a credential from vault storage by ID |
| `vault_credential_search` | Search vault credentials by keyword across names and content |
| `vault_credential_get_totp` | Get the current TOTP code for a credential with a TOTP secret |

### Webhook (5 tools)

| Tool | Description |
|------|-------------|
| `webhook_set` | Create or update a webhook subscription |
| `webhook_get` | Get a webhook subscription by ID |
| `webhook_list` | List webhook subscriptions with cursor pagination |
| `webhook_delete` | Delete a webhook subscription by ID |
| `webhook_test` | Send a test event to verify endpoint reachability and signature verification |

## Contributing: the contract gates

Every tool here is a thin client over the Anima REST API, which makes two lies easy
to ship and nearly impossible to notice — both return a green `200`:

- a tool calling a route the API doesn't have, and
- a tool advertising a parameter its route ignores (the API validates with Zod,
  which **strips** unknown input, so the server answers as if nothing was wrong
  and the model believes its filter was applied).

Two CI gates in `src/__tests__/integration/contract-parity.test.ts` make both
impossible. They check `src/tool-routes.ts` — where each tool declares the routes
it calls and any param it handles client-side — against
`src/__tests__/fixtures/contract-routes.json`, a snapshot of the real
`@anima/contracts` route surface.

**Adding or changing a tool** means updating its entry in `src/tool-routes.ts`.
If a gate fails, fix the tool: editing the declaration to match a lie, or parking a
param in `clientParams`, re-opens the exact hole the gates close.

**Refreshing the snapshot** (needs a checkout of the anima monorepo — it is private,
so CI cannot do this for you):

```bash
bun run contracts:refresh -- --anima ../anima   # rewrite the snapshot
bun run contracts:check   -- --anima ../anima   # diff only; non-zero on drift
```

## Community

Join the [Anima Discord](https://discord.gg/pY3GK59Z9E) to ask questions in `#mcp`, share what you're building in `#showcase`, and stay up to date with releases in `#announcements`.

## License

MIT
