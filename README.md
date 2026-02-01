# eq — your team Developer CLI

A developer productivity CLI that bridges **Notion** (ticket tracking) and **GitHub** (PRs/code). See your tickets, inspect PR status, and run bugbot-buster — all from the terminal.

## Installation

```bash
# Clone and install
cd /root/tix
npm install
npm run build
npm link   # makes `eq` available globally
```

## Setup

Run the interactive setup wizard:

```bash
eq setup
```

You'll be prompted for:
- **Notion API key** — create an integration at https://www.notion.so/my-integrations
- **Notion database ID** — the database where your team tracks tickets (paste the URL, the ID is extracted automatically)
- **Your name** — as it appears in Notion's "Assigned to" field
- **GitHub org** — default org for PR references (e.g. `your-org`)

Config is saved to `~/.eqrc.json`.

### Notion Integration Setup

1. Go to https://www.notion.so/my-integrations
2. Create a new integration for your workspace
3. Copy the "Internal Integration Token" (starts with `secret_` or `ntn_`)
4. In Notion, share your ticket database with the integration (click "..." → "Add connections")

## Commands

### `tix status`

Shows your assigned tickets in a color-coded table:

```
📋 Tickets for Andy

┌─────────────────────────────────────────────┬──────────────────┬────────────────┬──────────────┐
│ Title                                       │ Status           │ Priority       │ Updated      │
├─────────────────────────────────────────────┼──────────────────┼────────────────┼──────────────┤
│ Fix auth token refresh                      │ In Progress      │ 🟠 High        │ 1/15/2025    │
│ Add webhook retry logic                     │ To Do            │ 🟡 Medium      │ 1/14/2025    │
│ Update API docs                             │ Done             │ 🟢 Low         │ 1/13/2025    │
└─────────────────────────────────────────────┴──────────────────┴────────────────┴──────────────┘
```

### `tix ticket <notion-url-or-id>`

Deep-dive into a single ticket. Shows full details and fetches GitHub PR status:

```bash
# With a Notion URL
eq ticket "https://www.notion.so/workspace/Fix-auth-token-abc123def456"

# With just the ID
eq ticket abc123def456
```

Displays:
- Ticket properties (status, priority, assignee, etc.)
- All GitHub PRs found in the ticket content
- For each PR: state (open/merged/closed), CI check status, review status

### `tix inspect <notion-url-or-id>`

Debug command to inspect a Notion page or database structure. Essential for figuring out property names:

```bash
# Inspect your ticket database
eq inspect "https://www.notion.so/workspace/abc123def456?v=..."

# Inspect a specific page
eq inspect "https://www.notion.so/workspace/Some-Page-abc123def456"
```

Outputs:
- Property names and types
- Select/status options with colors
- Relation and rollup configurations
- Full JSON dump

### `tix bust <pr>`

Run bugbot-buster on a GitHub PR:

```bash
# With a URL
eq bust "https://github.com/your-org/api/pull/42"

# With shorthand (uses configured GitHub org)
eq bust "api#42"

# With options
eq bust "api#42" --dry-run --verbose --ai claude
```

Options:
- `--dry-run` — preview without making changes
- `--verbose` — detailed output
- `--ai <engine>` — choose AI engine: `claude` or `codex` (default: `codex`)
- `--authors <filter>` — author filter (default: `cursor`)

## Prerequisites

- **Node.js** ≥ 18
- **GitHub CLI** (`gh`) — installed and authenticated (`gh auth login`)
- **Notion integration** — with access to your team's database

## Config File

`~/.eqrc.json`:

```json
{
  "notionApiKey": "secret_...",
  "notionDatabaseId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "userName": "Andy",
  "githubOrg": "your-org"
}
```

## Tips

- Use `tix inspect` first to discover your database's property names — they may differ from the defaults
- The `status` command filters by name matching, so your `userName` must match how Notion displays your name in the "Assigned to" (or similar) people property
- PR detection scans page content blocks for GitHub URLs — make sure PRs are linked in your tickets
