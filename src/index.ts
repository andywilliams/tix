#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand } from './commands/setup';
import { statusCommand } from './commands/status';
import { ticketCommand } from './commands/ticket';
import { inspectCommand } from './commands/inspect';
import { bustCommand } from './commands/bust';
import { workCommand } from './commands/work';
import { reviewCommand } from './commands/review';
import { reviewConfigCommand } from './commands/review-config';
import { syncCommand } from './commands/sync';

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
  .command('status')
  .description('Show your assigned tickets from Notion')
  .action(async () => {
    try {
      await statusCommand();
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
  .action(async () => {
    try {
      await syncCommand();
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

program.parse();
