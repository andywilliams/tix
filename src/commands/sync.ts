import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../lib/config';
import { saveSyncedTickets } from '../lib/ticket-store';
import type { TicketSummary } from '../types';

interface SyncOptions {
  verbose?: boolean;
  timeout?: string;
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const config = loadConfig();
  const verbose = !!options.verbose;
  const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : 300_000;

  console.log(chalk.bold.cyan('\n🔄 tix sync — Fetch tickets via Claude CLI\n'));

  const prompt = [
    `Search Notion for tickets assigned to "${config.userName}".`,
    'Return ONLY a JSON array (no markdown fences, no explanation) matching this schema:',
    '',
    '[',
    '  {',
    '    "id": "notion-page-id",',
    '    "ticketNumber": "NEW-123",',
    '    "title": "Ticket title",',
    '    "status": "Status value",',
    '    "priority": "Priority value",',
    '    "lastUpdated": "YYYY-MM-DD",',
    '    "url": "https://www.notion.so/...",',
    '    "githubLinks": ["https://github.com/..."]',
    '  }',
    ']',
    '',
    'IMPORTANT instructions:',
    '- Query the database ONCE. All fields (including "New ID") are page properties visible in the query results.',
    '- "ticketNumber" comes from the "New ID" database property. Do NOT open individual pages to find it.',
    '- Exclude tickets with completed statuses (Done, Complete, Completed, Shipped, Released, Closed, Won\'t Do).',
    '- For githubLinks, only use URLs visible in page properties. Do NOT read page content/blocks.',
    '- If a field is unknown, use an empty string or empty array.',
    '- Return ONLY the JSON array, nothing else.',
  ].join('\n');

  const tmpFile = path.join(os.tmpdir(), `tix-sync-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  if (verbose) {
    console.log(chalk.dim('Prompt written to: ' + tmpFile));
    console.log(chalk.dim('Prompt content:'));
    console.log(chalk.dim(prompt));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(chalk.dim(`Timeout: ${timeoutMs / 1000}s`));
  }

  const claudeCmd = 'claude';
  const claudeArgs = ['--print', '--allowedTools', 'mcp__notion__*', '-p', prompt];

  if (verbose) {
    console.log(chalk.dim(`Running: ${claudeCmd} ${claudeArgs.map(a => a.length > 50 ? a.slice(0, 50) + '...' : a).join(' ')}`));
  }

  console.log(chalk.dim('Invoking Claude CLI to fetch tickets from Notion...'));

  // Spinner for progress feedback
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  const startTime = Date.now();
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r${spinnerFrames[frame % spinnerFrames.length]} Waiting for Claude... (${elapsed}s)`);
    frame++;
  }, 100);

  let output: string;
  try {
    output = await runClaude(claudeArgs, timeoutMs, verbose);
  } catch (err: any) {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    console.error(chalk.red(`\nSync failed: ${err.message}`));
    if (err.stderr) {
      console.error(chalk.dim('\nClaude stderr:'));
      console.error(chalk.dim(err.stderr));
    }
    if (err.message.includes('ETIMEDOUT') || err.message.includes('timed out')) {
      console.log(chalk.dim(`\nThe request timed out after ${timeoutMs / 1000}s.`));
      console.log(chalk.dim('Try increasing the timeout: tix sync --timeout 600'));
    }
    if (err.message.includes('ENOENT') || err.message.includes('not found')) {
      console.log(chalk.dim('\n`claude` CLI not found. Install it: npm install -g @anthropic-ai/claude-code'));
    }
    process.exit(1);
  } finally {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(chalk.dim(`Claude responded in ${elapsed}s`));

  if (verbose) {
    console.log(chalk.dim('\nRaw output:'));
    console.log(chalk.dim(output.slice(0, 2000)));
    if (output.length > 2000) console.log(chalk.dim(`... (${output.length - 2000} more chars)`));
    console.log(chalk.dim('─'.repeat(40)));
  }

  // Extract JSON array from output (handle possible markdown fences)
  let jsonStr = output;
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    console.error(chalk.red('Could not find a JSON array in Claude output.'));
    console.log(chalk.dim('\nRaw output (first 500 chars):'));
    console.log(chalk.dim(output.slice(0, 500)));
    console.log(chalk.dim('\nThis usually means Claude could not access Notion.'));
    console.log(chalk.dim('Check that your Claude Code has a Notion MCP server configured.'));
    process.exit(1);
  }

  let tickets: TicketSummary[];
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Not an array');

    tickets = parsed.map((t: any) => ({
      id: String(t.id || ''),
      ticketNumber: String(t.ticketNumber || ''),
      title: String(t.title || ''),
      status: String(t.status || ''),
      priority: String(t.priority || ''),
      lastUpdated: String(t.lastUpdated || ''),
      url: String(t.url || ''),
      githubLinks: Array.isArray(t.githubLinks) ? t.githubLinks.map(String) : [],
    }));
  } catch (err: any) {
    console.error(chalk.red(`Failed to parse ticket data: ${err.message}`));
    console.log(chalk.dim('\nExtracted JSON (first 500 chars):'));
    console.log(chalk.dim(arrayMatch[0].slice(0, 500)));
    process.exit(1);
  }

  saveSyncedTickets(tickets);

  console.log(chalk.green(`\n✅ Synced ${tickets.length} ticket(s)\n`));
  for (const t of tickets) {
    const status = t.status ? chalk.dim(`[${t.status}]`) : '';
    console.log(`  ${chalk.bold(t.title)} ${status}`);
  }
  console.log('');
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
          // Sometimes Claude returns useful output even with non-zero exit
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

    // Close stdin since we're passing prompt via -p flag
    child.stdin.end();
  });
}
