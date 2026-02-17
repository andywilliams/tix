#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand, setupSlackCommand } from './commands/setup';
import { setupNotionCommand } from './commands/setup-notion';
import { statusCommand } from './commands/status';
import { ticketCommand } from './commands/ticket';
import { inspectCommand } from './commands/inspect';
import { bustCommand } from './commands/bust';
import { workCommand } from './commands/work';
import { reviewCommand } from './commands/review';
import { reviewConfigCommand } from './commands/review-config';
import { syncCommand } from './commands/sync';
import { syncGhCommand } from './commands/sync-gh';
import { prsCommand } from './commands/prs';
import { cronCommand } from './commands/cron';
import { cronSetupCommand } from './commands/cron-setup';
import { standupCommand } from './commands/standup';
import { logCommand } from './commands/log';
import { summaryCommand } from './commands/summary';

const program = new Command();

program
  .name('eq')
  .description('Developer CLI — Notion tickets, GitHub PRs, and Bugbot Buster in one place')
  .version('0.1.0');

program
  .command('setup')
  .description('Interactive setup wizard — configure Notion, GitHub, and your identity')
  .action(async () => {
    try {
      await setupCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('setup-slack')
  .description('Configure Slack webhook for standup posting')
  .action(async () => {
    try {
      await setupSlackCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('setup-notion')
  .description('Configure Notion sync for tix-kanban board')
  .action(async () => {
    try {
      await setupNotionCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show your assigned tickets from Notion')
  .option('--completed <period>', 'Filter completed tickets: none, week, 2weeks, month, quarter, year')
  .action(async (options: any) => {
    try {
      await statusCommand(options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('ticket <notion-url-or-id>')
  .description('Deep-dive into a single ticket — shows details, GitHub PRs, CI status')
  .action(async (notionUrlOrId: string) => {
    try {
      await ticketCommand(notionUrlOrId);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('inspect <notion-url-or-id>')
  .description('Inspect a Notion page or database — dump full structure as JSON')
  .action(async (notionUrlOrId: string) => {
    try {
      await inspectCommand(notionUrlOrId);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('bust <pr>')
  .description('Run bugbot-buster on a GitHub PR')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--verbose', 'Enable verbose output')
  .option('--ai <engine>', 'AI engine to use (claude|codex)', 'codex')
  .option('--authors <authors>', 'Author filter for bugbot', 'cursor')
  .action(async (pr: string, options: any) => {
    try {
      await bustCommand(pr, options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('work <ticket>')
  .description('Implement a ticket with AI — fetches context, creates branch, runs AI, offers PR')
  .option('--repo <owner/repo>', 'Target repository (skip auto-detection)')
  .option('--ai <provider>', 'AI provider: claude (default), codex, codex-interactive', 'claude')
  .option('--branch <name>', 'Custom branch name (skip auto-generation)')
  .option('--no-pr', 'Skip PR creation prompt')
  .option('--dry-run', 'Show what would be done without executing')
  .action(async (ticket: string, options: any) => {
    try {
      await workCommand(ticket, options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('review <pr-number>')
  .description('AI-powered code review for a GitHub PR')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex')
  .option('-H, --harshness <level>', 'Review harshness: chill, medium, pedantic')
  .option('--dry-run', 'Show comments without posting', false)
  .option('--batch', 'Post all comments without prompting', false)
  .option('--full-context', 'Include full file contents for pattern analysis')
  .option('--usage-context', 'Include files that use changed symbols')
  .action(async (prNumber: string, options: any) => {
    try {
      await reviewCommand(prNumber, options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync tickets from Notion via Claude CLI (no API key needed)')
  .option('--verbose', 'Show detailed logs for debugging')
  .option('--timeout <seconds>', 'Timeout in seconds (default: 60)')
  .option('--discover', 'Re-discover the Notion database (clears cached data source ID)')
  .action(async (options: any) => {
    try {
      await syncCommand(options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('prs')
  .description('Show all your open GitHub PRs with ticket IDs')
  .action(async () => {
    try {
      await prsCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('sync-gh')
  .description('Search GitHub for PRs matching cached tickets (no Notion fetch)')
  .action(async () => {
    try {
      await syncGhCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('review-config')
  .description('Configure default settings for AI code reviews')
  .action(async () => {
    try {
      await reviewConfigCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('open <ticket>')
  .description('Open a ticket\'s Notion page in the browser')
  .action(async (ticket: string) => {
    const { loadSyncedTickets, findTicketByIdOrUrl } = await import('./lib/ticket-store');
    const { execSync } = await import('child_process');
    const tickets = loadSyncedTickets();
    const found = findTicketByIdOrUrl(ticket, tickets);
    if (!found || !found.url) {
      console.error(`Ticket not found: ${ticket}`);
      process.exit(1);
    }
    execSync(`open "${found.url}"`, { stdio: 'inherit' });
  });

program
  .command('open-pr <number>')
  .description('Open a GitHub PR in the browser by number')
  .action(async (prNumber: string) => {
    const { execSync } = await import('child_process');
    const { loadCachedPRs } = await import('./lib/ticket-store');
    const num = parseInt(prNumber, 10);
    if (isNaN(num)) {
      console.error(`Invalid PR number: ${prNumber}`);
      process.exit(1);
    }
    const prs = loadCachedPRs();
    const match = prs.find(pr => pr.number === num);
    if (!match) {
      console.error(`PR #${num} not found in cache. Run \`tix sync-gh\` first.`);
      process.exit(1);
    }
    execSync(`open "${match.url}"`, { stdio: 'inherit' });
  });

program
  .command('cron <action> [args...]')
  .description('Manage cron jobs for automated kanban task processing')
  .action(async (action: string, args: string[]) => {
    try {
      await cronCommand(action, ...args);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('cron-setup')
  .description('Interactive setup for kanban cron worker system')
  .action(async () => {
    try {
      await cronSetupCommand();
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('standup')
  .description('Generate daily standup from git commits and GitHub activity')
  .option('--save', 'Save standup to local history')
  .option('--week', 'Show standup history for the past week')
  .option('--slack', 'Post standup to configured Slack webhook')
  .option('--hours <number>', 'Hours to look back for activity (default: 24)')
  .action(async (options: any) => {
    try {
      await standupCommand(options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('log [message]')
  .description('Quick work log entries — `tix log "did X"` or interactive mode')
  .option('--show', 'Show recent log entries instead of adding')
  .option('--days <number>', 'Number of days to show (default: 1)')
  .option('--date <date>', 'Show entries for specific date (YYYY-MM-DD)')
  .action(async (message?: string, options?: any) => {
    try {
      await logCommand(message, options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('summary')
  .description('Generate weekly summaries from standups + git + log entries')
  .option('--week <date>', 'Week to summarize (YYYY-MM-DD, defaults to last week)')
  .option('--save', 'Save summary to local history')
  .option('--history', 'Show previous weekly summaries')
  .option('--weeks <number>', 'Number of weeks to show in history (default: 4)')
  .action(async (options: any) => {
    try {
      await summaryCommand(options);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// Catch-all: treat unknown commands that look like ticket IDs as `tix ticket <id>`
program.on('command:*', async (operands: string[]) => {
  const arg = operands[0];
  if (arg && /^[A-Za-z]+-\d+$/.test(arg)) {
    try {
      await ticketCommand(arg);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${arg}`);
    program.help();
  }
});

program.parse();
