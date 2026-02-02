# Sync Notion Tickets to Local Files

You have access to the Notion MCP server. Use it to sync tickets from a Notion database to local markdown files that `tix` can read.

## Steps

1. **Read the config** from `~/.eqrc.json` (or `$HOME/.eqrc.json`). Extract:
   - `notionDatabaseId` — the Notion database to query
   - `userName` — the current user's name (for reference, but sync ALL tickets)

   If `~/.eqrc.json` doesn't exist or doesn't have `notionDatabaseId`, ask the user for the database ID.

2. **Query the Notion database** using the Notion MCP tools. Fetch all pages from the database. For each page, extract:
   - `id` — the page ID
   - `title` — from the title property
   - `status` — from Status/State/Stage property
   - `priority` — from Priority/Importance/Urgency property
   - `assignee` — from Assigned to/Assignee/Owner/People property
   - `url` — the Notion page URL
   - `lastUpdated` — the page's last_edited_time
   - `githubLinks` — any GitHub URLs found in properties or page content

3. **For each ticket**, fetch the page content blocks to get the description body text.

4. **Write each ticket** to `.tix/tickets/<id>.md` using this exact format:

   ```markdown
   ---
   id: <notion-page-id>
   title: "<title>"
   status: "<status>"
   priority: "<priority>"
   assignee: "<assignee>"
   url: <notion-url>
   lastUpdated: "<ISO 8601 date>"
   githubLinks:
     - <url1>
     - <url2>
   ---

   ## Description
   <body text from page blocks>
   ```

   Make sure the `id` in the filename matches the `id` in the frontmatter, but use the raw ID without dashes for the filename (e.g., `.tix/tickets/abc123def456.md`).

5. **Write `.tix/index.json`** — a manifest of all synced tickets:

   ```json
   {
     "lastSynced": "<ISO 8601 timestamp>",
     "ticketCount": <number>,
     "tickets": [
       {
         "id": "<notion-page-id>",
         "title": "<title>",
         "status": "<status>",
         "priority": "<priority>",
         "assignee": "<assignee>",
         "url": "<notion-url>",
         "lastUpdated": "<ISO date>",
         "githubLinks": ["<url1>", "<url2>"],
         "file": "tickets/<id>.md"
       }
     ]
   }
   ```

6. **Create the `.tix/` directory** if it doesn't exist (including `.tix/tickets/`).

7. **Report results**: Print how many tickets were synced and the timestamp.

## Important Notes

- Sync ALL tickets from the database, not just the user's. The CLI handles filtering.
- If a ticket has no status/priority/assignee, use empty strings.
- GitHub links: scan both page properties (URL type) and content blocks for `github.com` URLs.
- Quote YAML string values that contain special characters.
- Use the Notion MCP `search` or database query tools — do NOT use the Notion REST API directly.
