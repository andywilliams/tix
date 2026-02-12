import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../lib/config';
import { saveSyncedTickets } from '../lib/ticket-store';
import type { TicketSummary } from '../types';

export async function syncCommand(): Promise<void> {
  const config = loadConfig();

  console.log(chalk.bold.cyan('\n🔄 tix sync — Fetch tickets via Claude CLI\n'));

  const prompt = [
    `Search Notion for tickets assigned to "${config.userName}".`,
    'Return ONLY a JSON array (no markdown fences, no explanation) matching this schema:',
    '',
    '[',
    '  {',
    '    "id": "notion-page-id",',
    '    "title": "Ticket title",',
    '    "status": "Status value",',
    '    "priority": "Priority value",',
    '    "lastUpdated": "YYYY-MM-DD",',
    '    "url": "https://www.notion.so/...",',
    '    "githubLinks": ["https://github.com/..."]',
    '  }',
    ']',
    '',
    'Include all tickets assigned to this person regardless of status.',
    'For githubLinks, extract any GitHub URLs found in the ticket content.',
    'If a field is unknown, use an empty string or empty array as appropriate.',
    'Return ONLY the JSON array, nothing else.',
  ].join('\n');

  const tmpFile = path.join(os.tmpdir(), `tix-sync-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  console.log(chalk.dim('Invoking Claude CLI to fetch tickets from Notion...'));

  let output: string;
  try {
    output = execSync(`claude --print < "${tmpFile}"`, {
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    if (err.status === 127 || (err.message && err.message.includes('not found'))) {
      console.error(chalk.red('`claude` CLI not found.'));
      console.log(chalk.dim('Install it: npm install -g @anthropic-ai/claude-code'));
    } else if (err.killed) {
      console.error(chalk.red('Claude CLI timed out (120s). Try again later.'));
    } else {
      console.error(chalk.red(`Claude CLI failed: ${err.message}`));
    }
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
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
    console.log(chalk.dim('Raw output:'));
    console.log(chalk.dim(output.slice(0, 500)));
    process.exit(1);
  }

  let tickets: TicketSummary[];
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Not an array');

    tickets = parsed.map((t: any) => ({
      id: String(t.id || ''),
      title: String(t.title || ''),
      status: String(t.status || ''),
      priority: String(t.priority || ''),
      lastUpdated: String(t.lastUpdated || ''),
      url: String(t.url || ''),
      githubLinks: Array.isArray(t.githubLinks) ? t.githubLinks.map(String) : [],
    }));
  } catch (err: any) {
    console.error(chalk.red(`Failed to parse ticket data: ${err.message}`));
    console.log(chalk.dim('Extracted JSON:'));
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
