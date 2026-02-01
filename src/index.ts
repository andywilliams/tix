#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand } from './commands/setup';
import { statusCommand } from './commands/status';
import { ticketCommand } from './commands/ticket';
import { inspectCommand } from './commands/inspect';
import { bustCommand } from './commands/bust';

const program = new Command();

program
  .name('eq')
  .description('Equals Money developer CLI — bridges Notion tickets and GitHub PRs')
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

program.parse();
