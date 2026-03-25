# @anima-labs/mcp

MCP (Model Context Protocol) server for Anima — 77 tools for AI agent communication.

## Installation

```bash
bun add @anima-labs/mcp
```

## Quick Start

```bash
# stdio mode (default — for Claude Desktop, Cursor, etc.)
bun run node_modules/@anima-labs/mcp/src/index.ts

# HTTP mode (for web integrations)
bun run node_modules/@anima-labs/mcp/src/index.ts --http --port=8014
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANIMA_API_URL` | No | API server URL (default: `http://127.0.0.1:3100`) |
| `ANIMA_API_KEY` | Yes | Agent API key (`ak_` prefix) |
| `ANIMA_MASTER_KEY` | No | Master key (`mk_` prefix) for admin tools |

## Claude Desktop Configuration

```json
{
  "mcpServers": {
    "anima": {
      "command": "bun",
      "args": ["run", "node_modules/@anima-labs/mcp/src/index.ts"],
      "env": {
        "ANIMA_API_KEY": "ak_your_api_key_here"
      }
    }
  }
}
```

## 77 Tools

| Category | Count | Examples |
|----------|------:|---------|
| Organization | 6 | `org_create`, `org_get`, `org_list` |
| Agent | 6 | `agent_create`, `agent_get`, `agent_list` |
| Email | 19 | `email_send`, `email_reply`, `email_search` |
| Domain | 7 | `domain_add`, `domain_verify`, `domain_list` |
| Phone | 6 | `phone_search`, `phone_send_sms` |
| Message | 7 | `message_send_email`, `message_search` |
| Webhook | 7 | `webhook_create`, `webhook_test` |
| Security | 5 | `security_approve`, `security_scan_content` |
| Utility | 14 | `whoami`, `call_agent`, `wait_for_email` |

## License

MIT
