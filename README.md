# tix — Developer CLI

A developer productivity CLI that bridges **Notion** (ticket tracking) and **GitHub** (PRs/code). See your tickets, check PR status, implement tickets with AI, and run bugbot-buster — all from the terminal.

## Installation

```bash
git clone git@github.com:andywilliams/tix.git
cd tix
npm install
npm run build
npm link   # makes `tix` available globally
```

## Setup

Run the interactive setup wizard:

```bash
tix setup
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

Shows your assigned tickets in a color-coded table with PR and comment info:

```
📋 Tickets for Andy

┌──────────────────────────────────────┬────────────────┬──────────────┬──────┬──────────┬────────────┐
│ Title                                │ Status         │ Priority     │ PRs  │ Comments │ Updated    │
├──────────────────────────────────────┼────────────────┼──────────────┼──────┼──────────┼────────────┤
│ Fix auth token refresh               │ In Progress    │ 🟠 High      │ 2    │ 3        │ 1/15/2025  │
│ Add webhook retry logic              │ To Do          │ 🟡 Medium    │ —    │ —        │ 1/14/2025  │
│ Update API docs                      │ Done           │ 🟢 Low       │ 1    │ ✓        │ 1/13/2025  │
└──────────────────────────────────────┴────────────────┴──────────────┴──────┴──────────┴────────────┘
```

- **PRs** — number of linked GitHub PRs found in the ticket
- **Comments** — total unresolved review comments across linked PRs (✓ = all resolved)

### `tix ticket <notion-url-or-id>`

Deep-dive into a single ticket. Shows full details and fetches GitHub PR status:

```bash
# With a Notion URL
tix ticket "https://www.notion.so/workspace/Fix-auth-token-abc123def456"

# With just the ID
tix ticket abc123def456
```

Displays:
- Ticket properties (status, priority, assignee, etc.)
- All GitHub PRs found in the ticket content
- For each PR: state (open/merged/closed), CI check status, review status

### `tix work <ticket-url-or-id>`

Implement a ticket using AI. Fetches the ticket from Notion, sets up a branch, and launches an AI coding assistant with the full ticket context:

```bash
# Implement a ticket with Claude (default)
tix work "https://www.notion.so/workspace/Fix-auth-token-abc123def456"

# Use Codex in full-auto mode
tix work "https://notion.so/..." --ai codex

# Use Codex interactively
tix work "https://notion.so/..." --ai codex-interactive

# Specify the target repo (skip auto-detection)
tix work "https://notion.so/..." --repo your-org/api

# Custom branch name
tix work "https://notion.so/..." --branch fix/auth-token

# Skip PR creation prompt
tix work "https://notion.so/..." --no-pr

# Preview without making changes
tix work "https://notion.so/..." --dry-run
```

**Flow:**
1. Fetches ticket details from Notion (title, description, acceptance criteria)
2. Scans ticket for GitHub links to detect the target repo
3. If multiple repos or none found, prompts you to choose
4. Creates a branch (`tix/<ticket-slug>`) from latest main
5. Launches AI with the ticket context as the task
6. When done, offers to create a PR linking back to the ticket

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `--repo <owner/repo>` | Target repository | auto-detect |
| `--ai <provider>` | AI provider: `claude`, `codex`, `codex-interactive` | `claude` |
| `--branch <name>` | Custom branch name | `tix/<ticket-slug>` |
| `--no-pr` | Skip PR creation prompt | `false` |
| `--dry-run` | Preview without executing | `false` |

### `tix inspect <notion-url-or-id>`

Debug command to inspect a Notion page or database structure. Essential for figuring out property names:

```bash
# Inspect your ticket database
tix inspect "https://www.notion.so/workspace/abc123def456?v=..."

# Inspect a specific page
tix inspect "https://www.notion.so/workspace/Some-Page-abc123def456"
```

Outputs:
- Property names and types
- Select/status options with colours
- Relation and rollup configurations
- Full JSON dump

### `tix bust <pr>`

Run [bugbot-buster](https://github.com/andywilliams/bugbot-buster) on a GitHub PR — automatically fix unresolved review comments using AI:

```bash
# With a URL
tix bust "https://github.com/your-org/api/pull/42"

# With shorthand (uses configured GitHub org)
tix bust "api#42"

# With options
tix bust "api#42" --dry-run --verbose --ai claude
```

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Preview without making changes | `false` |
| `--verbose` | Detailed output | `false` |
| `--ai <engine>` | AI engine: `codex` or `claude` | `codex` |
| `--authors <filter>` | Only fix comments from these authors | `cursor` |

### `tix sync`

Sync tickets from Notion via **Claude Code MCP** — no Notion API key required. This is ideal when your team can't distribute a shared API key, but developers have Notion MCP set up in Claude Code or Cursor.

```bash
tix sync
```

**How it works:**
1. Claude Code connects to Notion via the MCP server configured in `.mcp.json`
2. It queries your ticket database and writes each ticket to `.tix/tickets/<id>.md`
3. It also writes `.tix/index.json` as a manifest
4. Other tix commands (`status`, `ticket`, `work`) automatically read from local files when no API key is configured

**Setup:**
1. Copy `.mcp.json` from the project root (already included in the repo)
2. Replace `YOUR_NOTION_TOKEN` with your personal Notion integration token
3. Make sure [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) is installed: `npm install -g @anthropic-ai/claude-code`
4. Run `tix sync`

**When no API key is configured**, all commands fall back to the local `.tix/` cache and show:
```
📁 Reading from local cache (last synced: 1/15/2025, 3:42:00 PM). Run `tix sync` to refresh.
```

> **Note:** `tix sync` requires the Claude Code CLI. If it's not available, tix will print instructions for running the sync manually using the `/sync-tickets` slash command in Claude Code or Cursor.

## Prerequisites

- **Node.js** ≥ 18
- **GitHub CLI** (`gh`) — installed and authenticated (`gh auth login`)
- **Notion integration** — with access to your team's database
- **Claude Code** or **Codex CLI** — for `tix work` and `tix bust`

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

> **`notionApiKey` is optional.** If omitted, tix operates in "local mode" — reading from `.tix/` files synced via `tix sync`. Run `tix setup` and leave the API key blank to use this mode.

### MCP-Based Sync (No API Key)

If your team can't distribute a Notion API key, each developer can use their own Notion integration via Claude Code MCP:

1. **Create a Notion integration** at https://www.notion.so/my-integrations (each dev creates their own)
2. **Share the database** with your integration
3. **Edit `.mcp.json`** in the project root — replace `YOUR_NOTION_TOKEN` with your token
4. **Run `tix sync`** to pull tickets into `.tix/tickets/`
5. All tix commands work normally, reading from the local cache

## Tips

- Use `tix inspect` first to discover your database's property names — they may differ from the defaults
- The `status` command filters by name matching, so your `userName` must match how Notion displays your name in the "Assigned to" (or similar) people property
- PR detection scans page content blocks for GitHub URLs — make sure PRs are linked in your tickets
- `tix work` defaults to Claude for interactive sessions where you can guide the AI — use `--ai codex` for fully autonomous implementation
