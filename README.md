# tix — Developer CLI

A developer productivity CLI that bridges **Notion** (ticket tracking) and **GitHub** (PRs/code). See your tickets, check PR status, implement tickets with AI, run AI code reviews, and run bugbot-buster — all from the terminal.

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

You'll be asked to choose a connection mode:

### Option A: Notion API Key (direct access)

You'll be prompted for:
- **Notion API key** — create an integration at https://www.notion.so/my-integrations
- **Notion database ID** — the database where your team tracks tickets (paste the URL, the ID is extracted automatically)
- **Your name** — as it appears in Notion's "Assigned to" field
- **GitHub org** — default org for PR references (e.g. `your-org`)

#### Notion Integration Setup

1. Go to https://www.notion.so/my-integrations
2. Create a new integration for your workspace
3. Copy the "Internal Integration Token" (starts with `secret_` or `ntn_`)
4. In Notion, share your ticket database with the integration (click "..." → "Add connections")

### Option B: Claude CLI with Notion MCP (sync mode)

If you don't have a Notion API key but have Claude Code configured with a Notion MCP server, you can use sync mode instead. You'll only be prompted for:
- **Your name** — as it appears in Notion's "Assigned to" field
- **GitHub org** — default org for PR references

Then run `tix sync` to fetch your tickets via Claude CLI. Tickets are cached locally in `~/.tix/tickets/` and used by `tix status`, `tix ticket`, and `tix work`.

Config is saved to `~/.eqrc.json`.

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

Completed tickets (done, shipped, closed, won't do, etc.) are automatically hidden if they were last updated more than a week ago. Use `--completed` to change the filter:

```bash
# Hide all completed tickets
tix status --completed none

# Show completed tickets from the last 2 weeks
tix status --completed 2weeks

# Show completed tickets from the last month
tix status --completed month
```

Available periods: `none`, `week` (default), `2weeks`, `month`, `quarter`, `year`. Your choice is saved to `~/.tix/settings.json` and used in future runs.

### `tix sync`

Fetch your tickets from Notion via Claude CLI (for sync mode — no API key required). Requires Claude Code with a Notion MCP server configured:

```bash
tix sync
```

Invokes `claude --print` with a prompt asking for your assigned tickets as JSON. Results are cached to `~/.tix/tickets/_summary.json`. Run this periodically to keep your local ticket data up to date.

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

### `tix review <pr-number>`

AI-powered code review for a GitHub pull request. Fetches the PR diff, sends it to an AI for analysis, and lets you interactively select which comments to post:

```bash
# Review a PR in the current repo
tix review 42

# Review a PR in a specific repo
tix review 42 --repo your-org/api

# Preview comments without posting
tix review 42 --dry-run

# Post all comments without prompting
tix review 42 --batch

# Override saved settings
tix review 42 --ai codex --harshness pedantic
```

**Flow:**
1. Fetches PR details and diff from GitHub
2. Optionally gathers full file contents and symbol usage context
3. Sends everything to the AI (Claude or Codex) for review
4. Displays each comment with severity, file, and line number
5. You choose which comments to add, skip, or quit
6. Selected comments are posted as a single GitHub review

**Options:**
| Option | Description | Default (saved) |
|--------|-------------|-----------------|
| `-r, --repo <owner/repo>` | GitHub repository | current repo |
| `-a, --ai <provider>` | AI provider: `claude`, `codex` | `claude` |
| `-H, --harshness <level>` | `chill`, `medium`, or `pedantic` | `medium` |
| `--dry-run` | Show comments without posting | `false` |
| `--batch` | Post all comments without prompting | `false` |
| `--full-context` | Include full file contents for pattern analysis | `true` |
| `--usage-context` | Find callers of changed symbols for context | `true` |

CLI flags override saved settings. Use `tix review-config` to change defaults.

### `tix review-config`

Interactive editor for review default settings. Settings are saved to `~/.tix/settings.json`:

```bash
tix review-config
```

Lets you configure:
- **AI provider** — Claude or Codex
- **Harshness** — chill (bugs only), medium (bugs + code smells), pedantic (thorough)
- **Full context** — send complete file contents alongside the diff
- **Usage context** — find and include callers of changed symbols

You can also reset all settings to defaults.

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

## Prerequisites

- **Node.js** ≥ 18
- **GitHub CLI** (`gh`) — installed and authenticated (`gh auth login`)
- **Notion integration** — with access to your team's database
- **Claude Code** or **Codex CLI** — for `tix work`, `tix bust`, and `tix review`
- **ripgrep** (`rg`) — optional, used by `tix review --usage-context` to find symbol usages

## Config File

`~/.eqrc.json`:

```json
// API mode (all fields)
{
  "notionApiKey": "secret_...",
  "notionDatabaseId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "userName": "Andy",
  "githubOrg": "your-org"
}

// Sync mode (no API key — uses `tix sync` instead)
{
  "userName": "Andy",
  "githubOrg": "your-org"
}
```

## Settings

`~/.tix/settings.json` (created automatically). Each tool gets its own section:

```json
{
  "review": {
    "ai": "claude",
    "harshness": "medium",
    "fullContext": true,
    "usageContext": true
  },
  "status": {
    "completedPeriod": "week"
  }
}
```

Edit review settings interactively with `tix review-config`, or pass CLI flags to `tix review` for one-off overrides. The `status.completedPeriod` is set automatically when you use `tix status --completed <period>`.

## Tips

- Use `tix inspect` first to discover your database's property names — they may differ from the defaults
- The `status` command filters by name matching, so your `userName` must match how Notion displays your name in the "Assigned to" (or similar) people property
- PR detection scans page content blocks for GitHub URLs — make sure PRs are linked in your tickets
- `tix work` defaults to Claude for interactive sessions where you can guide the AI — use `--ai codex` for fully autonomous implementation
- In sync mode, run `tix sync` regularly to keep cached tickets fresh — `tix status` shows when tickets were last synced
- Sync mode works with any Claude MCP setup that has Notion access — no need to create a dedicated Notion API integration
