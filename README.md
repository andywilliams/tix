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

### `tix prs`

Shows all your open GitHub PRs with ticket IDs, review status, and unresolved comment counts:

```bash
tix prs
```

```
🔀 Open Pull Requests

┌────────┬────────────┬──────────────────────┬────────────────────────────┬──────────────┬──────────┬────────────┐
│ #      │ Ticket     │ Repo                 │ Title                      │ Review       │ Comments │ Updated    │
├────────┼────────────┼──────────────────────┼────────────────────────────┼──────────────┼──────────┼────────────┤
│ 2586   │ TN-11835   │ em-transactions-api  │ TN-11835 Add validation... │ ✓ approved   │ ✓        │ 2026-02-10 │
│ 415    │ TN-9969    │ em-reports-api       │ TN-9969 Update descript... │ ◐ pending    │ 2        │ 2026-02-10 │
│ 88     │ —          │ tix                  │ Fix table column widths    │ —            │ ✓        │ 2026-02-08 │
└────────┴────────────┴──────────────────────┴────────────────────────────┴──────────────┴──────────┴────────────┘
```

Ticket IDs are extracted from PR title prefixes (e.g. "TN-11835 Add validation..." → `TN-11835`). Uses your GitHub username from `gh auth` and scopes to your configured `githubOrg`.

### `tix sync`

Fetch your tickets from Notion via Claude CLI (for sync mode — no API key required). Requires Claude Code with a Notion MCP server configured:

```bash
tix sync
```

Invokes `claude --print` with a prompt asking for your assigned tickets as JSON. Results are cached to `~/.tix/tickets/_summary.json`. Run this periodically to keep your local ticket data up to date.

### `tix sync-gh`

Search GitHub for PRs matching each cached ticket's ID and save the links locally. Much faster than `tix sync` since it doesn't touch Notion:

```bash
tix sync-gh
```

For each cached ticket with a ticket number (e.g. `TN-11835`), searches GitHub for PRs with that ID in the title and writes the PR URLs into the ticket cache. After running this, `tix status` will show PR counts and comment info without needing to search GitHub again.

**Recommended workflow:**
```bash
tix sync        # fetch tickets from Notion (slow, do occasionally)
tix sync-gh     # find PRs for each ticket (fast, do often)
tix status      # view everything
```

### `tix open <ticket>`

Open a ticket's Notion page in the browser:

```bash
tix open tn-4266
```

Looks up the ticket in your local cache and opens the Notion URL. Case-insensitive — `TN-4266`, `tn-4266`, etc. all work.

### `tix open-pr <number>`

Open a GitHub PR in the browser by number:

```bash
tix open-pr 1516
```

Searches your open PRs (scoped to your GitHub org) and opens the first match. Useful when you see a PR number in `tix prs` and want to jump straight to it.

### `tix ticket <notion-url-or-id>`

Deep-dive into a single ticket. Shows full details and fetches GitHub PR status:

```bash
# With a ticket number (shorthand — no subcommand needed)
tix tn-11835

# With a Notion URL
tix ticket "https://www.notion.so/workspace/Fix-auth-token-abc123def456"

# With just the Notion page ID
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

### `tix standup`

Auto-generate daily standups from git and GitHub activity:

```bash
# Generate today's standup
tix standup

# Save the standup locally
tix standup --save

# View this week's saved standups
tix standup --week

# Post directly to Slack
tix standup --slack
```

Scans your configured repos for:
- Git commits from the last 24 hours
- GitHub PRs opened, merged, reviewed, or closed
- Formats into **Yesterday / Today / Blockers** sections

Saved standups are stored in `~/.tix/standups/`. The `--slack` flag posts to a configured Slack webhook (set up via `tix setup`).

### `tix log`

Quick work log entries for capturing what you're doing between tickets:

```bash
# Log an entry
tix log "Investigated auth bug in em-contracts"

# Interactive mode (prompts for entry)
tix log

# View today's log
tix log --show

# View last 3 days
tix log --show --days 3

# View a specific date
tix log --show --date 2026-02-17
```

Entries are timestamped and stored in `~/.tix/logs/YYYY-MM-DD.json`. More freeform than tickets — captures the stuff between formal tasks.

### `tix summary`

Generate weekly summaries from multiple sources:

```bash
# Generate this week's summary
tix summary

# Save the summary
tix summary --save

# View past summaries
tix summary --history

# Summary for a specific week (by start date)
tix summary --week 2026-02-10
```

Aggregates data from:
- Saved standups (`tix standup --save`)
- Git commits across all configured repos
- Work log entries (`tix log`)
- GitHub PR activity (opened/merged/closed)

Generates key accomplishments, repo breakdowns, and next-week focus suggestions. Perfect for sprint retros, 1:1s, and manager updates. Summaries saved to `~/.tix/summaries/`.

### `tix cron-setup`

Interactive setup wizard for the automated kanban task processing system:

```bash
tix cron-setup
```

Sets up cron jobs that automatically:
- Monitor DWLF kanban board for AI-assigned tasks
- Pick up highest priority backlog tasks
- Execute tasks using Claude CLI
- Add progress comments and links to kanban tasks
- Track execution history and manage concurrent sessions

### `tix cron <action>`

Manage cron jobs for automated task processing:

```bash
# List all cron jobs
tix cron list

# Add a new cron job (30 min intervals, max 1 concurrent)
tix cron add "Kanban Worker" "*/30 * * * *" 1

# Enable/disable jobs
tix cron enable <job-id>
tix cron disable <job-id>

# Remove a job entirely
tix cron remove <job-id>

# Trigger job immediately
tix cron trigger <job-id>

# View job execution history
tix cron runs <job-id>

# Start/stop the cron daemon
tix cron start
tix cron stop
```

**Cron system features:**
- Configurable intervals (every 10-60 minutes recommended)
- Concurrent session limits (prevents resource conflicts)
- Execution history with full logs stored in `~/.tix-kanban/runs/`
- Automatic task status management (backlog → in-progress → review)
- Integration with DWLF kanban API for task picking and updates

**Workflow:**
1. System picks highest priority backlog task assigned to AI
2. Checks if task already has work done (skips if so)
3. Moves task to in-progress status
4. Spawns Claude CLI with full task context
5. Captures output and updates kanban task with results
6. Creates PR links and detailed comments automatically

## Tips

- Use `tix inspect` first to discover your database's property names — they may differ from the defaults
- The `status` command filters by name matching, so your `userName` must match how Notion displays your name in the "Assigned to" (or similar) people property
- PR detection works by searching GitHub for PRs whose title contains the ticket number — name your PRs like "TN-123 Fix the thing" for automatic linking
- `tix work` defaults to Claude for interactive sessions where you can guide the AI — use `--ai codex` for fully autonomous implementation
- In sync mode, run `tix sync` occasionally to refresh tickets from Notion, then `tix sync-gh` to quickly find associated PRs
- Sync mode works with any Claude MCP setup that has Notion access — no need to create a dedicated Notion API integration
- Use `tix tn-123` as a shorthand for `tix ticket tn-123` — any argument matching a ticket ID pattern is automatically treated as a ticket lookup
- The cron system works best with intervals of 20-30 minutes to avoid overwhelming the API
- Set maxConcurrent to 1 for single-threaded task processing, or 2-3 for parallel work if your system can handle it
