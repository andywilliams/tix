import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfigPermissive } from '../lib/config';

/**
 * Check if the `claude` CLI is available.
 */
function hasClaudeCli(): boolean {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the project root (where .mcp.json or package.json lives).
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.mcp.json')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export async function syncCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n🔄 tix sync — Sync tickets via Claude Code MCP\n'));

  const config = loadConfigPermissive();

  if (config?.notionApiKey) {
    console.log(chalk.dim('ℹ You have a Notion API key configured. Sync is for use without one.'));
    console.log(chalk.dim('  Your other commands will use the API directly.\n'));
  }

  if (!config?.notionDatabaseId) {
    console.log(chalk.yellow('⚠ No notionDatabaseId found in ~/.eqrc.json'));
    console.log(chalk.dim('  Run `tix setup` or add notionDatabaseId to your config.\n'));
  }

  const projectRoot = findProjectRoot();

  if (!hasClaudeCli()) {
    console.log(chalk.yellow('⚠ `claude` CLI not found.\n'));
    console.log(chalk.bold('To sync tickets, you need Claude Code CLI installed:'));
    console.log(chalk.dim('  npm install -g @anthropic-ai/claude-code\n'));
    console.log(chalk.bold('Manual alternative:'));
    console.log(chalk.dim('  1. Open this project in Claude Code or Cursor'));
    console.log(chalk.dim('  2. Ensure Notion MCP is configured in .mcp.json'));
    console.log(chalk.dim('  3. Run the /sync-tickets slash command'));
    console.log(chalk.dim('  4. Tickets will be written to .tix/tickets/\n'));
    return;
  }

  // Check for .mcp.json
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (!fs.existsSync(mcpPath)) {
    console.log(chalk.yellow('⚠ No .mcp.json found in project root.'));
    console.log(chalk.dim('  Copy the template and add your Notion token:'));
    console.log(chalk.dim(`  ${mcpPath}\n`));
    return;
  }

  // Ensure .tix directories exist
  const tixDir = path.join(projectRoot, '.tix');
  const ticketsDir = path.join(tixDir, 'tickets');
  if (!fs.existsSync(ticketsDir)) {
    fs.mkdirSync(ticketsDir, { recursive: true });
  }

  console.log(chalk.dim('Syncing tickets via Claude Code MCP...'));
  console.log(chalk.dim(`Project root: ${projectRoot}\n`));

  try {
    // Use claude --print to run the sync-tickets command non-interactively
    const prompt = buildSyncPrompt(config?.notionDatabaseId);

    execSync(`claude --print "${prompt.replace(/"/g, '\\"')}"`, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env },
      timeout: 120_000, // 2 minute timeout
    });
  } catch (err: any) {
    if (err.status === 127 || (err.message && err.message.includes('not found'))) {
      console.error(chalk.red('\n⚠ `claude` CLI not found.'));
      console.log(chalk.dim('Install it: npm install -g @anthropic-ai/claude-code'));
      return;
    }
    // Non-zero exit from claude is sometimes expected
    console.log(chalk.yellow('\nClaude Code exited — checking results...\n'));
  }

  // Report results
  reportSyncResults(projectRoot);
}

function buildSyncPrompt(databaseId?: string): string {
  const parts = [
    'Run the /sync-tickets workflow:',
    'Use the Notion MCP to query the ticket database and write results to .tix/tickets/ as markdown files with YAML frontmatter.',
    'Also write .tix/index.json as the manifest.',
  ];

  if (databaseId) {
    parts.push(`The Notion database ID is: ${databaseId}`);
  }

  return parts.join(' ');
}

function reportSyncResults(projectRoot: string): void {
  const indexPath = path.join(projectRoot, '.tix', 'index.json');

  if (!fs.existsSync(indexPath)) {
    console.log(chalk.yellow('⚠ No .tix/index.json found after sync.'));
    console.log(chalk.dim('  The sync may not have completed. Try running manually:'));
    console.log(chalk.dim('  claude /sync-tickets\n'));
    return;
  }

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const count = index.ticketCount ?? index.tickets?.length ?? 0;
    const lastSynced = index.lastSynced
      ? new Date(index.lastSynced).toLocaleString()
      : 'unknown';

    console.log(chalk.green(`\n✅ Synced ${count} ticket(s)`));
    console.log(chalk.dim(`   Last synced: ${lastSynced}`));
    console.log(chalk.dim(`   Files: .tix/tickets/\n`));
  } catch {
    console.log(chalk.yellow('⚠ Could not read .tix/index.json'));
  }
}
