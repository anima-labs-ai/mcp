# @anima-labs/mcp

MCP (Model Context Protocol) server for Anima -- 133 tools across 15 categories for AI agent communication, identity, payments, and security.

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
npx @anima-labs/mcp --tools=email,cards,vault
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANIMA_API_URL` | No | API server URL (default: `http://127.0.0.1:3100`) |
| `ANIMA_API_KEY` | Yes | Agent API key (`ak_` prefix) |
| `ANIMA_MASTER_KEY` | No | Master key (`mk_` prefix) for admin tools |

## Selective Tool Loading

Use the `--tools` flag to load only the tool groups you need. This reduces the tool count exposed to the LLM, which can improve tool selection accuracy and reduce token usage.

```bash
npx @anima-labs/mcp --tools=email,cards,vault
```

Available tool groups:

| Group | Description |
|-------|-------------|
| `org` | Organization management |
| `agent` | Agent CRUD and key rotation |
| `email` | Email send, receive, search, folders, templates |
| `domain` | Domain setup, DNS, verification, deliverability |
| `phone` | Phone number provisioning, SMS, status |
| `vault` | Credential vault management and TOTP |
| `cards` | Virtual card issuing, policies, approvals |
| `funding` | Funding sources and holds |
| `message` | Unified messaging (email + SMS) |
| `webhook` | Webhook management and delivery logs |
| `security` | Security events, policies, content scanning |
| `utility` | Health checks, agent messaging, metadata |
| `browser` | Browser payment detection and checkout |
| `x402` | HTTP 402 payment protocol |
| `invoice` | Invoice processing and reconciliation |

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
      "args": ["-y", "@anima-labs/mcp", "--tools=email,cards,vault"],
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

### Organization (6 tools)

| Tool | Description |
|------|-------------|
| `org_create` | Create a new organization |
| `org_get` | Get organization by ID |
| `org_list` | List organizations |
| `org_update` | Update organization settings |
| `org_delete` | Delete an organization |
| `org_rotate_key` | Rotate organization master key |

### Agent (6 tools)

| Tool | Description |
|------|-------------|
| `agent_create` | Create a new agent with optional metadata |
| `agent_get` | Get agent by ID |
| `agent_list` | List agents with pagination |
| `agent_update` | Update agent settings |
| `agent_delete` | Delete an agent |
| `agent_rotate_key` | Rotate agent API key |

### Email (19 tools)

| Tool | Description |
|------|-------------|
| `email_send` | Send an email |
| `email_get` | Get email by ID |
| `email_list` | List emails with filters |
| `email_reply` | Reply to an email |
| `email_forward` | Forward an email |
| `email_search` | Search emails by query |
| `inbox_digest` | Get inbox digest summary |
| `email_mark_read` | Mark email as read |
| `email_mark_unread` | Mark email as unread |
| `batch_mark_read` | Batch mark emails as read |
| `batch_mark_unread` | Batch mark emails as unread |
| `batch_delete` | Batch delete emails |
| `batch_move` | Batch move emails to folder |
| `email_move` | Move a single email |
| `email_delete` | Delete a single email |
| `manage_folders` | Create, list, or delete email folders |
| `manage_contacts` | Manage email contacts |
| `manage_templates` | Manage email templates |
| `template_send` | Send email using a template |

### Domain (9 tools)

| Tool | Description |
|------|-------------|
| `domain_add` | Add a custom sending domain |
| `domain_verify` | Verify domain DNS records |
| `domain_get` | Get domain details |
| `domain_list` | List all domains |
| `domain_update` | Update domain configuration |
| `domain_delete` | Delete a domain |
| `domain_dns_records` | Get required DNS records |
| `domain_deliverability` | Check domain deliverability |
| `domain_zone_file` | Get full DNS zone file |

### Phone (8 tools)

| Tool | Description |
|------|-------------|
| `phone_search` | Search available phone numbers |
| `phone_provision` | Provision a phone number |
| `phone_release` | Release a phone number |
| `phone_get` | Get phone number details by ID |
| `phone_list` | List provisioned numbers |
| `phone_update_config` | Update phone number configuration |
| `phone_send_sms` | Send an SMS message |
| `phone_status` | Get status of provisioned numbers |

### Vault (12 tools)

| Tool | Description |
|------|-------------|
| `vault_provision` | Provision vault for an agent |
| `vault_deprovision` | Deprovision agent vault |
| `vault_list_credentials` | List vault credentials |
| `vault_get_credential` | Get credential by ID |
| `vault_create_credential` | Create a new credential |
| `vault_update_credential` | Update an existing credential |
| `vault_delete_credential` | Delete a credential |
| `vault_search` | Search credentials by keyword |
| `vault_sync` | Force vault sync |
| `vault_generate_password` | Generate a secure password |
| `vault_get_totp` | Get current TOTP code |
| `vault_status` | Check vault provisioning status |

### Cards (23 tools)

| Tool | Description |
|------|-------------|
| `create_card` | Create a virtual card with spend limits |
| `list_cards` | List cards with optional status filter |
| `get_card` | Get card details by ID |
| `update_card` | Update card label or spending limits |
| `delete_card` | Delete a card |
| `freeze_card` | Freeze a card to block transactions |
| `unfreeze_card` | Unfreeze a frozen card |
| `get_transactions` | List card transactions |
| `get_transaction` | Get single transaction details |
| `get_spending_summary` | Get normalized spending summary |
| `create_spending_policy` | Create a spending policy |
| `list_spending_policies` | List spending policies for a card |
| `update_spending_policy` | Update a spending policy |
| `delete_spending_policy` | Delete a spending policy |
| `kill_switch` | Emergency freeze all cards in scope |
| `create_cardholder` | Create a cardholder profile |
| `get_cardholder` | Get cardholder by ID |
| `list_cardholders` | List cardholders |
| `update_cardholder` | Update cardholder details |
| `delete_cardholder` | Delete a cardholder |
| `list_approvals` | List card authorization approvals |
| `approve_authorization` | Approve a pending authorization |
| `decline_authorization` | Decline a pending authorization |

### Funding (7 tools)

| Tool | Description |
|------|-------------|
| `funding_create_source` | Create a funding source |
| `funding_list_sources` | List funding sources |
| `funding_create_hold` | Create a funding hold |
| `funding_capture_hold` | Capture a funding hold |
| `funding_release_hold` | Release a funding hold |
| `funding_get_hold` | Get hold details |
| `funding_list_holds` | List funding holds |

### Message (9 tools)

| Tool | Description |
|------|-------------|
| `message_send_email` | Send email via unified messaging |
| `message_send_sms` | Send SMS via unified messaging |
| `message_get` | Get message by ID |
| `message_list` | List messages with filters |
| `message_search` | Search messages |
| `message_semantic_search` | Semantic search across messages |
| `conversation_search` | Search conversations |
| `message_upload_attachment` | Upload a message attachment |
| `message_get_attachment` | Get attachment download URL |

### Webhook (7 tools)

| Tool | Description |
|------|-------------|
| `webhook_create` | Create a webhook endpoint |
| `webhook_get` | Get webhook by ID |
| `webhook_update` | Update webhook configuration |
| `webhook_delete` | Delete a webhook |
| `webhook_list` | List webhooks |
| `webhook_test` | Send a test event to a webhook |
| `webhook_list_deliveries` | List webhook delivery history |

### Security (5 tools)

| Tool | Description |
|------|-------------|
| `security_approve` | Approve a security event |
| `security_list_events` | List security events |
| `security_get_policy` | Get security policy |
| `security_update_policy` | Update security policy |
| `security_scan_content` | Scan content for threats |

### Utility (14 tools)

| Tool | Description |
|------|-------------|
| `whoami` | Get current agent identity |
| `check_health` | Check API health status |
| `list_agents` | Quick agent listing |
| `manage_pending` | Manage pending follow-ups |
| `check_followups` | Check pending follow-ups |
| `message_agent` | Send inter-agent message |
| `check_messages` | Check for new messages |
| `wait_for_email` | Wait for an email to arrive |
| `call_agent` | Call another agent |
| `update_metadata` | Update agent metadata |
| `setup_email_domain` | Quick email domain setup |
| `send_test_email` | Send a test email |
| `manage_spam` | Manage spam settings |
| `check_tasks` | Check task status |

### Browser Payments (4 tools)

| Tool | Description |
|------|-------------|
| `browser_detect_checkout` | Detect checkout page elements |
| `browser_pay_checkout` | Pay a checkout |
| `browser_fill_card` | Fill card details on page |
| `browser_fill_address` | Fill address on page |

### x402 (1 tool)

| Tool | Description |
|------|-------------|
| `x402_fetch` | Fetch a resource using HTTP 402 payment protocol |

### Invoice (3 tools)

| Tool | Description |
|------|-------------|
| `invoice_process` | Process an invoice |
| `invoice_auto_pay` | Auto-pay an invoice |
| `invoice_reconcile` | Reconcile invoices |

## License

MIT
