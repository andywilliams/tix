import chalk from 'chalk';
import { spawn } from 'child_process';
import { loadConfig, saveConfig } from '../lib/config';
import { saveSyncedTickets } from '../lib/ticket-store';
import type { EqConfig, TicketSummary } from '../types';

interface SyncOptions {
  verbose?: boolean;
  timeout?: string;
  discover?: boolean;
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const config = loadConfig();
  const verbose = !!options.verbose;
  const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : 60_000;

  console.log(chalk.bold.cyan('\n🔄 tix sync — Fetch tickets via Claude CLI\n'));

  // Phase 1: If --discover, fetch the database to find the data source ID
  if (options.discover) {
    if (!config.notionDatabaseUrl) {
      console.error(chalk.red('No notionDatabaseUrl in config. Run `tix setup` and provide your Notion database URL.'));
      process.exit(1);
    }
    console.log(chalk.dim('Discovering data source ID via notion-fetch...'));
    try {
      const dsId = await discoverDataSourceId(config.notionDatabaseUrl, timeoutMs, verbose);
      config.notionDataSourceId = dsId;
      saveConfig(config);
      console.log(chalk.green(`✅ Discovered data source: ${dsId}`));
    } catch (err: any) {
      console.error(chalk.red(`Discovery failed: ${err.message}`));
      if (err.stderr) console.error(chalk.dim(err.stderr));
    }
    return;
  }

  // Phase 2: Fast sync — try view mode, then SQL mode, then fallback
  let output: string | null = null;
  const startTime = Date.now();

  // Strategy A: View mode (needs notionDatabaseUrl with ?v= param)
  // Skip view mode if we have a data source ID — SQL mode is more reliable
  if (!config.notionDataSourceId && config.notionDatabaseUrl && config.notionDatabaseUrl.includes('?v=')) {
    if (verbose) console.log(chalk.dim('Trying view mode with URL: ' + config.notionDatabaseUrl));
    console.log(chalk.dim('Querying Notion database view...'));

    const { stop } = startSpinner(startTime);
    try {
      const result = await runViewModeSync(config.notionDatabaseUrl, timeoutMs, verbose);
      // Check if the result looks like an error rather than data
      if (result && !result.includes('error') && !result.includes('Invalid')) {
        output = result;
      } else if (verbose) {
        console.log(chalk.dim('View mode returned an error, falling through...'));
      }
    } catch (err: any) {
      stop();
      if (verbose) console.log(chalk.dim(`View mode failed: ${err.message}`));
    } finally {
      stop();
    }
  }

  // Strategy B: SQL mode (needs notionDataSourceId) — preferred when available
  if (!output && config.notionDataSourceId) {
    if (verbose) console.log(chalk.dim('Trying SQL mode with data source: ' + config.notionDataSourceId));
    console.log(chalk.dim('Querying Notion via SQL...'));

    const { stop } = startSpinner(startTime);
    try {
      output = await runSqlModeSync(config.notionDataSourceId, config.userName, timeoutMs, verbose, config.notionUserId);
    } catch (err: any) {
      stop();
      if (verbose) console.log(chalk.dim(`SQL mode failed: ${err.message}`));
    } finally {
      stop();
    }
  }

  // Strategy C: Fallback open-ended query
  if (!output) {
    console.log(chalk.dim('Fast sync unavailable. Falling back to open-ended query...'));
    const { stop } = startSpinner(startTime);
    try {
      output = await runFallbackSync(config.userName, timeoutMs, verbose);
    } catch (err: any) {
      stop();
      console.error(chalk.red(`\nSync failed: ${err.message}`));
      handleSyncError(err, timeoutMs);
      process.exit(1);
    } finally {
      stop();
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(chalk.dim(`Claude responded in ${elapsed}s`));

  if (verbose) {
    console.log(chalk.dim('\nRaw output:'));
    console.log(chalk.dim(output.slice(0, 2000)));
    if (output.length > 2000) console.log(chalk.dim(`... (${output.length - 2000} more chars)`));
    console.log(chalk.dim('─'.repeat(40)));
  }

  // Phase 3: Extract result from --output-format json wrapper if present
  let parsedOutput = output;
  try {
    const wrapper = JSON.parse(output);
    if (wrapper && typeof wrapper.result === 'string') {
      parsedOutput = wrapper.result;
      if (verbose) console.log(chalk.dim('Extracted result from JSON wrapper'));
    }
  } catch { /* not JSON-wrapped, use raw output */ }

  const tickets = parseTicketsFromOutput(parsedOutput);

  if (tickets === null) {
    console.error(chalk.red('Could not parse ticket data from Claude output.'));
    console.log(chalk.dim('\nRaw output (first 500 chars):'));
    console.log(chalk.dim(parsedOutput.slice(0, 500)));
    process.exit(1);
  }

  saveSyncedTickets(tickets);

  console.log(chalk.green(`\n✅ Synced ${tickets.length} ticket(s)\n`));
  for (const t of tickets) {
    const status = t.status ? chalk.dim(`[${t.status}]`) : '';
    const id = t.ticketNumber ? chalk.cyan(t.ticketNumber) + ' ' : '';
    console.log(`  ${id}${chalk.bold(t.title)} ${status}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Strategy A: View mode — uses the database view URL directly
// ---------------------------------------------------------------------------

function runViewModeSync(databaseUrl: string, timeoutMs: number, verbose: boolean): Promise<string> {
  const prompt = [
    'Call the notion-query-data-sources tool with EXACTLY these parameters:',
    `{"data": {"mode": "view", "view_url": "${databaseUrl}"}}`,
    '',
    'Return ONLY the raw tool output, no explanation.',
  ].join('\n');

  return runClaude(
    [
      '--print',
      '--model', 'haiku',
      '--allowedTools', 'mcp__notion__notion-query-data-sources',
      '--append-system-prompt', 'Make exactly ONE tool call with the exact parameters given. Return the raw result immediately. No exploration.',
      '-p', prompt,
    ],
    timeoutMs,
    verbose,
  );
}

// ---------------------------------------------------------------------------
// Strategy B: SQL mode — uses the collection:// data source ID
// ---------------------------------------------------------------------------

function runSqlModeSync(dsId: string, userName: string, timeoutMs: number, verbose: boolean, notionUserId?: string): Promise<string> {
  const assigneeFilter = notionUserId
    ? `"Assignee" LIKE '%${notionUserId}%'`
    : `"Assignee" LIKE '%${userName}%'`;
  const sqlQuery = `SELECT "New ID", "Title", "Status", "Priority", "Assignee", "Last edited time", "url", "GitHub Pull Requests" FROM "collection://${dsId}" WHERE "Status" NOT IN ('Done', 'Complete', 'Completed', 'Shipped', 'Released', 'Closed', 'Won''t Do', 'Won''t do', 'Merged') AND ${assigneeFilter}`;

  if (verbose) console.log(chalk.dim('SQL: ' + sqlQuery));

  const dsUrl = `collection://${dsId}`;
  const prompt = `Query Notion database ${dsUrl} with this SQL:\n${sqlQuery}\n\nReturn only the raw JSON result.`;

  return runClaude(
    [
      '--print',
      '--model', 'haiku',
      '--output-format', 'json',
      '--allowedTools', 'mcp__notion__notion-query-data-sources',
      '--append-system-prompt', 'Make exactly ONE tool call. Return only the raw result JSON. No commentary.',
      '-p', prompt,
    ],
    timeoutMs,
    verbose,
  );
}

// ---------------------------------------------------------------------------
// Strategy C: Fallback open-ended query
// ---------------------------------------------------------------------------

function runFallbackSync(userName: string, timeoutMs: number, verbose: boolean): Promise<string> {
  const prompt = [
    `Search Notion for tickets assigned to "${userName}".`,
    'Return ONLY a JSON array (no markdown fences, no explanation) matching this schema:',
    '',
    '[{"id":"notion-page-id","ticketNumber":"NEW-123","title":"Ticket title","status":"Status value","priority":"Priority value","lastUpdated":"YYYY-MM-DD","url":"https://www.notion.so/...","githubLinks":["https://github.com/..."]}]',
    '',
    'IMPORTANT: Query the database ONCE. Use "New ID" property for ticketNumber.',
    'Exclude completed statuses (Done, Complete, Shipped, Released, Closed, Won\'t Do).',
    'Return ONLY the JSON array.',
  ].join('\n');

  return runClaude(
    [
      '--print',
      '--model', 'haiku',
      '--allowedTools', 'mcp__notion__*',
      '--append-system-prompt', 'Query the database ONCE. Return only the JSON array. Do not open individual pages or explore the schema.',
      '-p', prompt,
    ],
    Math.max(timeoutMs, 120_000),
    verbose,
  );
}

// ---------------------------------------------------------------------------
// Discovery: fetch the database to get the collection:// data source ID
// ---------------------------------------------------------------------------

async function discoverDataSourceId(databaseUrl: string, timeoutMs: number, verbose: boolean): Promise<string> {
  const prompt = [
    `Call the notion-fetch tool with id="${databaseUrl}".`,
    'In the result, find the <data-source url="collection://..."> tag.',
    'Return ONLY the UUID from inside that tag (the part after "collection://"), nothing else.',
  ].join('\n');

  const output = await runClaude(
    [
      '--print',
      '--model', 'haiku',
      '--allowedTools', 'mcp__notion__notion-fetch',
      '--append-system-prompt', 'Make exactly ONE tool call. Return only the UUID. No explanation.',
      '-p', prompt,
    ],
    timeoutMs,
    verbose,
  );

  const uuidMatch = output.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (!uuidMatch) {
    throw new Error(`Could not extract data source ID from Claude output: ${output.slice(0, 200)}`);
  }

  return uuidMatch[0];
}

// ---------------------------------------------------------------------------
// Parse output rows into TicketSummary[]
// ---------------------------------------------------------------------------

const COMPLETED_STATUSES = new Set([
  'done', 'complete', 'completed', 'shipped', 'released', 'closed', "won't do", 'wont do', 'merged',
]);

function parseTicketsFromOutput(output: string): TicketSummary[] | null {
  let jsonStr = output;

  // Strip markdown fences
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Try parsing as {"results": [...]} wrapper first
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && Array.isArray(parsed.results)) return rowsToTickets(parsed.results);
  } catch { /* fall through */ }

  // Try JSON array
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const rows = JSON.parse(arrayMatch[0]);
      if (Array.isArray(rows)) return rowsToTickets(rows);
    } catch { /* fall through */ }
  }

  // Try individual JSON objects
  const objectMatches = jsonStr.match(/\{[^{}]+\}/g);
  if (objectMatches && objectMatches.length > 0) {
    try {
      const rows = objectMatches.map((m) => JSON.parse(m));
      return rowsToTickets(rows);
    } catch { /* fall through */ }
  }

  // If output looks like a markdown table, try to parse it
  const tableRows = parseMarkdownTable(output);
  if (tableRows) return rowsToTickets(tableRows);

  return null;
}

function parseMarkdownTable(output: string): Record<string, string>[] | null {
  const lines = output.split('\n').filter((l) => l.includes('|'));
  if (lines.length < 3) return null; // need header + separator + at least one row

  const parseRow = (line: string) =>
    line.split('|').map((c) => c.trim()).filter((c) => c && !c.match(/^-+$/));

  const headers = parseRow(lines[0]);
  if (headers.length === 0) return null;

  // Skip separator line (line with dashes)
  const dataLines = lines.filter((l) => !l.match(/^\s*\|[\s-|]+\|\s*$/));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < dataLines.length; i++) {
    const cells = parseRow(dataLines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] || '';
    });
    rows.push(row);
  }

  return rows.length > 0 ? rows : null;
}

function rowsToTickets(rows: any[]): TicketSummary[] {
  const tickets: TicketSummary[] = [];

  for (const row of rows) {
    const title = findField(row, ['title', 'name', 'task', 'ticket']) || '';
    const status = findField(row, ['status', 'state']) || '';

    if (COMPLETED_STATUSES.has(status.toLowerCase())) continue;

    const id = findField(row, ['id', 'page_id', 'pageid', 'notion_id']) || '';
    const rawTicketNumber = findField(row, ['new id', 'new_id', 'newid', 'ticket_number', 'ticketnumber', 'ticket id', 'ticket_id']) || '';
    const ticketNumber = rawTicketNumber && !rawTicketNumber.includes('-') ? `TN-${rawTicketNumber}` : rawTicketNumber;
    const priority = findField(row, ['priority', 'urgency']) || '';
    const lastUpdated = findField(row, ['last updated', 'last_updated', 'lastupdated', 'updated', 'last edited', 'last_edited_time']) || '';
    const url = findField(row, ['url', 'link', 'notion_url']) || '';

    const githubLinks: string[] = [];
    for (const [, val] of Object.entries(row)) {
      if (typeof val === 'string' && val.includes('github.com')) {
        githubLinks.push(...val.split(/[\s,]+/).filter((s: string) => s.includes('github.com')));
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && item.includes('github.com')) {
            githubLinks.push(item);
          }
        }
      }
    }

    tickets.push({
      id: String(id),
      ticketNumber: String(ticketNumber),
      title: String(title),
      status: String(status),
      priority: String(priority),
      lastUpdated: String(lastUpdated),
      url: String(url),
      githubLinks,
    });
  }

  return tickets;
}

function findField(row: Record<string, any>, candidates: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[_\s]/g, '');
    for (const key of keys) {
      if (key.toLowerCase().replace(/[_\s]/g, '') === normalized) {
        const val = row[key];
        if (val == null) return undefined;
        if (typeof val === 'string') return val;
        if (typeof val === 'number') return String(val);
        if (Array.isArray(val)) return val.join(', ');
        return JSON.stringify(val);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function handleSyncError(err: any, timeoutMs: number): void {
  if (err.stderr) {
    console.error(chalk.dim('\nClaude stderr:'));
    console.error(chalk.dim(err.stderr));
  }
  if (err.message.includes('ETIMEDOUT') || err.message.includes('timed out')) {
    console.log(chalk.dim(`\nThe request timed out after ${timeoutMs / 1000}s.`));
    console.log(chalk.dim('Try increasing the timeout: tix sync --timeout 120'));
  }
  if (err.message.includes('ENOENT') || err.message.includes('not found')) {
    console.log(chalk.dim('\n`claude` CLI not found. Install it: npm install -g @anthropic-ai/claude-code'));
  }
}

function startSpinner(startTime: number): { interval: ReturnType<typeof setInterval>; stop: () => void } {
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r${spinnerFrames[frame % spinnerFrames.length]} Waiting for Claude... (${elapsed}s)`);
    frame++;
  }, 100);

  const stop = () => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
  };

  return { interval, stop };
}

function runClaude(args: string[], timeoutMs: number, verbose: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (verbose) {
        process.stderr.write(chalk.dim(data.toString()));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const err: any = new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`);
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);

    child.on('error', (err: any) => {
      clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const err: any = new Error(`Claude CLI exited with code ${code}`);
        err.stderr = stderr;
        if (stdout.trim()) {
          if (verbose) {
            console.log(chalk.dim(`\nClaude exited with code ${code} but produced output, attempting to parse...`));
          }
          resolve(stdout.trim());
        } else {
          reject(err);
        }
      } else {
        resolve(stdout.trim());
      }
    });

    child.stdin.end();
  });
}
