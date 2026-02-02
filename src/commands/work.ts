import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, extractNotionId, isLocalMode, getLastSyncedDate } from '../lib/config';
import { createNotionClient, getTicketDetail, getLocalTicketDetail } from '../lib/notion';
import { checkGhCli } from '../lib/github';

interface WorkOptions {
  repo?: string;
  ai?: string;
  branch?: string;
  pr?: boolean;
  dryRun?: boolean;
}

/**
 * Slugify a ticket title into a branch-safe name.
 * Lowercase, hyphens, max 60 chars.
 */
function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

/**
 * Extract owner/repo from a GitHub URL.
 */
function extractRepoFromUrl(url: string): string | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Get the plain text body of a Notion page's blocks.
 */
async function getPageBodyText(notion: any, pageId: string): Promise<string> {
  const lines: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const response: any = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results) {
        const blockType = block.type;
        if (!blockType || !block[blockType]) continue;
        const content = block[blockType];
        if (content.rich_text) {
          const text = content.rich_text.map((t: any) => t.plain_text).join('');
          if (text) lines.push(text);
        }
      }
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);
  } catch {
    // Content might not be accessible
  }
  return lines.join('\n');
}

/**
 * Detect the default branch (main or master) for a repo.
 */
function getDefaultBranch(repoDir: string): string {
  try {
    const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    // e.g. "refs/remotes/origin/main"
    return result.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if main or master exists
    try {
      execSync('git rev-parse --verify origin/main', { cwd: repoDir, stdio: 'pipe' });
      return 'main';
    } catch {
      try {
        execSync('git rev-parse --verify origin/master', { cwd: repoDir, stdio: 'pipe' });
        return 'master';
      } catch {
        return 'main'; // last resort
      }
    }
  }
}

/**
 * Check if the git working tree is clean.
 */
function isGitClean(repoDir: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    return status.length === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a branch already exists locally.
 */
function branchExists(repoDir: string, branchName: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branchName}`, {
      cwd: repoDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export async function workCommand(ticketArg: string, options: WorkOptions): Promise<void> {
  const config = loadConfig();
  const isDryRun = !!options.dryRun;

  // ── Step 1: Fetch the ticket ──────────────────────────────────
  let pageId: string;
  try {
    pageId = extractNotionId(ticketArg);
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.bold.cyan('\n🔧 tix work — Implement a ticket with AI\n'));
  // Fetch ticket — use local cache if no API key
  let detail;
  let notion: any = null;

  if (!config.notionApiKey) {
    if (!isLocalMode()) {
      console.error(chalk.red('No Notion API key configured and no local ticket cache found.'));
      console.log(chalk.dim('Run `tix sync` to sync tickets via Claude Code MCP, or `tix setup` to add an API key.'));
      process.exit(1);
    }

    const lastSynced = getLastSyncedDate();
    const syncDate = lastSynced ? new Date(lastSynced).toLocaleString() : 'unknown';
    console.log(chalk.dim(`📁 Reading from local cache (last synced: ${syncDate}). Run \`tix sync\` to refresh.\n`));

    detail = getLocalTicketDetail(pageId);
    if (!detail) {
      console.error(chalk.red(`Ticket ${pageId} not found in local cache.`));
      console.log(chalk.dim('Run `tix sync` to refresh the local cache.'));
      process.exit(1);
    }
  } else {
    console.log(chalk.dim('Fetching ticket from Notion...'));
    notion = createNotionClient(config);
    try {
      detail = await getTicketDetail(notion, pageId);
    } catch (err: any) {
      console.error(chalk.red(`Failed to fetch ticket: ${err.message}`));
      process.exit(1);
    }
  }

  // ── Step 2: Extract ticket info ───────────────────────────────
  const bodyText = notion ? await getPageBodyText(notion, pageId) : '';

  console.log(chalk.bold.white(`\n📋 ${detail.title}`));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`${chalk.bold('Status:')}     ${detail.status}`);
  console.log(`${chalk.bold('Priority:')}   ${detail.priority}`);
  console.log(`${chalk.bold('Assignee:')}   ${detail.assignee}`);
  console.log(`${chalk.bold('Notion:')}     ${chalk.underline.blue(detail.url)}`);

  if (detail.githubLinks.length > 0) {
    console.log(`${chalk.bold('GitHub:')}     ${detail.githubLinks.join(', ')}`);
  }

  // ── Step 3: Determine which repo to work in ──────────────────
  let targetRepo: string | undefined = options.repo;

  if (!targetRepo) {
    // Try to extract from GitHub links in the ticket
    const repoSlugs = new Set<string>();
    for (const link of detail.githubLinks) {
      const slug = extractRepoFromUrl(link);
      if (slug) repoSlugs.add(slug);
    }

    const uniqueRepos = Array.from(repoSlugs);

    if (uniqueRepos.length === 1) {
      targetRepo = uniqueRepos[0];
      console.log(chalk.dim(`\nAuto-detected repo from ticket: ${chalk.bold(targetRepo)}`));
    } else if (uniqueRepos.length > 1) {
      const { chosen } = await inquirer.prompt([
        {
          type: 'list',
          name: 'chosen',
          message: 'Multiple repos found in ticket. Which one?',
          choices: [...uniqueRepos, new inquirer.Separator(), 'Other (type manually)'],
        },
      ]);
      targetRepo = chosen === 'Other (type manually)' ? undefined : chosen;
    }
  }

  if (!targetRepo && config.githubOrg) {
    // Prompt with org context
    const { repoName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'repoName',
        message: `Enter repo (owner/repo) [org: ${config.githubOrg}]:`,
        validate: (v: string) => (v.length > 0 ? true : 'Required'),
      },
    ]);
    targetRepo = repoName.includes('/') ? repoName : `${config.githubOrg}/${repoName}`;
  }

  if (!targetRepo) {
    const { repoName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'repoName',
        message: 'Enter target repository (owner/repo):',
        validate: (v: string) =>
          v.includes('/') ? true : 'Use format: owner/repo',
      },
    ]);
    targetRepo = repoName;
  }

  console.log(chalk.bold(`\n🎯 Repository: ${targetRepo}`));

  // ── Step 4: Locate the repo locally ───────────────────────────
  let repoDir: string | undefined;

  // Check if cwd matches the repo
  const cwdBasename = path.basename(process.cwd());
  const repoName = targetRepo!.split('/')[1];
  if (cwdBasename === repoName) {
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        stdio: 'pipe',
        encoding: 'utf-8',
      }).trim();
      if (remoteUrl.includes(targetRepo!)) {
        repoDir = process.cwd();
      }
    } catch {
      // Not a git repo or no remote
    }
  }

  // Check common paths
  if (!repoDir) {
    const commonPaths = [
      path.join(process.env.HOME || '~', repoName),
      path.join(process.env.HOME || '~', 'src', repoName),
      path.join(process.env.HOME || '~', 'projects', repoName),
      path.join(process.env.HOME || '~', 'code', repoName),
      path.join(process.env.HOME || '~', 'repos', repoName),
      path.join('/root', repoName),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, '.git'))) {
        repoDir = p;
        break;
      }
    }
  }

  if (!repoDir) {
    const { localPath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'localPath',
        message: `Local path for ${targetRepo}:`,
        default: path.join(process.cwd(), repoName),
        validate: (v: string) => (v.length > 0 ? true : 'Required'),
      },
    ]);

    if (!fs.existsSync(path.join(localPath, '.git'))) {
      // Offer to clone
      const { shouldClone } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'shouldClone',
          message: `Repo not found at ${localPath}. Clone it?`,
          default: true,
        },
      ]);

      if (shouldClone) {
        const cloneUrl = `https://github.com/${targetRepo}.git`;
        console.log(chalk.dim(`Cloning ${cloneUrl} → ${localPath}...`));
        if (!isDryRun) {
          try {
            execSync(`git clone ${cloneUrl} ${localPath}`, { stdio: 'inherit' });
          } catch (err: any) {
            console.error(chalk.red(`Failed to clone: ${err.message}`));
            process.exit(1);
          }
        } else {
          console.log(chalk.yellow(`[dry-run] Would clone ${cloneUrl} → ${localPath}`));
        }
      } else {
        console.error(chalk.red('Cannot proceed without a local repo.'));
        process.exit(1);
      }
    }

    repoDir = localPath;
  }

  // At this point repoDir is guaranteed to be set
  const workDir = repoDir!;
  console.log(chalk.dim(`Working in: ${workDir}`));

  // ── Step 5: Check git state ───────────────────────────────────
  if (!isDryRun && !isGitClean(workDir)) {
    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: chalk.yellow('Working tree has uncommitted changes. Proceed anyway?'),
        default: false,
      },
    ]);
    if (!proceed) {
      console.log(chalk.dim('Aborting. Commit or stash your changes first.'));
      process.exit(0);
    }
  }

  // ── Step 6: Create a branch ───────────────────────────────────
  const branchName = options.branch || `tix/${slugify(detail.title)}`;

  console.log(chalk.bold(`\n🌿 Branch: ${branchName}`));

  if (isDryRun) {
    console.log(chalk.yellow(`[dry-run] Would create branch: ${branchName}`));
  } else {
    // Fetch latest
    try {
      console.log(chalk.dim('Fetching latest from origin...'));
      execSync('git fetch origin', { cwd: workDir, stdio: 'pipe' });
    } catch {
      console.log(chalk.yellow('⚠ Could not fetch from origin. Continuing with local state.'));
    }

    const defaultBranch = getDefaultBranch(workDir);

    if (branchExists(workDir, branchName)) {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: `Branch "${branchName}" already exists. What to do?`,
          choices: [
            { name: 'Switch to it', value: 'switch' },
            { name: 'Delete and recreate', value: 'recreate' },
            { name: 'Abort', value: 'abort' },
          ],
        },
      ]);

      if (action === 'abort') {
        process.exit(0);
      } else if (action === 'switch') {
        execSync(`git checkout ${branchName}`, { cwd: workDir, stdio: 'inherit' });
      } else {
        execSync(`git checkout ${defaultBranch}`, { cwd: workDir, stdio: 'pipe' });
        execSync(`git branch -D ${branchName}`, { cwd: workDir, stdio: 'pipe' });
        execSync(`git checkout -b ${branchName} origin/${defaultBranch}`, {
          cwd: workDir,
          stdio: 'inherit',
        });
      }
    } else {
      // Checkout new branch from up-to-date default
      try {
        execSync(`git checkout -b ${branchName} origin/${defaultBranch}`, {
          cwd: workDir,
          stdio: 'inherit',
        });
      } catch {
        // If origin/default doesn't exist, try from local default
        execSync(`git checkout -b ${branchName}`, {
          cwd: workDir,
          stdio: 'inherit',
        });
      }
    }

    console.log(chalk.green(`✓ On branch ${branchName}`));
  }

  // ── Step 7: Build the AI prompt ───────────────────────────────
  const notionUrl = detail.url.startsWith('http')
    ? detail.url
    : `https://notion.so/${pageId.replace(/-/g, '')}`;

  const promptParts = [
    `# Ticket: ${detail.title}`,
    '',
    `**Notion URL:** ${notionUrl}`,
    `**Status:** ${detail.status}`,
    `**Priority:** ${detail.priority}`,
    '',
    '## Description',
    '',
    bodyText || '(No description found in ticket body)',
    '',
    '## Properties',
    '',
  ];

  // Add relevant properties
  for (const [key, value] of Object.entries(detail.properties)) {
    if (
      value &&
      value !== '—' &&
      !['Status', 'Priority', 'Assigned to', 'Assignee', 'Name', 'Title'].includes(key)
    ) {
      promptParts.push(`- **${key}:** ${value}`);
    }
  }

  promptParts.push('');
  promptParts.push('## Instructions');
  promptParts.push('');
  promptParts.push('Implement the requirements described in this ticket.');
  promptParts.push('Follow the existing code patterns and conventions in this repository.');
  promptParts.push('Write clean, well-tested code. Add or update tests as appropriate.');
  promptParts.push('If acceptance criteria are listed above, ensure all are met.');

  const prompt = promptParts.join('\n');

  console.log(chalk.dim('\n─── AI Prompt ───'));
  // Show a truncated preview
  const previewLines = prompt.split('\n').slice(0, 15);
  for (const line of previewLines) {
    console.log(chalk.dim(line));
  }
  if (prompt.split('\n').length > 15) {
    console.log(chalk.dim(`... (${prompt.split('\n').length - 15} more lines)`));
  }
  console.log(chalk.dim('─'.repeat(40)));

  // ── Step 8: Run the AI ────────────────────────────────────────
  const aiProvider = options.ai || 'claude';

  console.log(chalk.bold(`\n🤖 Running AI: ${aiProvider}\n`));

  if (isDryRun) {
    console.log(chalk.yellow(`[dry-run] Would run ${aiProvider} in ${workDir}`));
    console.log(chalk.yellow('[dry-run] Prompt length: ' + prompt.length + ' chars'));
  } else {
    if (aiProvider === 'claude') {
      // Run claude interactively with the prompt piped in
      console.log(chalk.dim('Launching Claude Code (interactive)...\n'));

      await new Promise<void>((resolve, reject) => {
        const child = spawn('claude', ['--print', '--prompt', prompt], {
          cwd: workDir,
          stdio: 'inherit',
          env: { ...process.env },
        });

        // Actually, claude CLI works better with just the prompt as argument
        // Let's use the simpler invocation
        child.on('close', (code) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            // Non-zero exit is okay for interactive tools
            resolve();
          }
        });

        child.on('error', (err) => {
          if ((err as any).code === 'ENOENT') {
            console.error(chalk.red('\n⚠ `claude` CLI not found.'));
            console.log(chalk.dim('Install it: npm install -g @anthropic-ai/claude-code'));
          }
          reject(err);
        });
      });
    } else if (aiProvider === 'codex') {
      // Run codex in full-auto mode
      console.log(chalk.dim('Running Codex (full-auto)...\n'));

      try {
        execSync(`codex exec --full-auto "${prompt.replace(/"/g, '\\"')}"`, {
          cwd: workDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
      } catch (err: any) {
        if (err.status === 127 || (err.message && err.message.includes('not found'))) {
          console.error(chalk.red('\n⚠ `codex` CLI not found.'));
          console.log(chalk.dim('Install it: npm install -g @openai/codex'));
        } else {
          console.log(chalk.yellow('Codex exited with code ' + (err.status || 'unknown')));
        }
      }
    } else if (aiProvider === 'codex-interactive') {
      // Run codex interactively
      console.log(chalk.dim('Launching Codex (interactive)...\n'));

      await new Promise<void>((resolve) => {
        const child = spawn('codex', [], {
          cwd: workDir,
          stdio: 'inherit',
          env: { ...process.env },
        });

        child.on('close', () => resolve());
        child.on('error', (err) => {
          if ((err as any).code === 'ENOENT') {
            console.error(chalk.red('\n⚠ `codex` CLI not found.'));
            console.log(chalk.dim('Install it: npm install -g @openai/codex'));
          }
          resolve();
        });
      });
    } else {
      console.error(chalk.red(`Unknown AI provider: ${aiProvider}`));
      console.log(chalk.dim('Supported: claude, codex, codex-interactive'));
      process.exit(1);
    }
  }

  // ── Step 9: Offer to create a PR ─────────────────────────────
  if (options.pr === false) {
    console.log(chalk.dim('\nSkipping PR creation (--no-pr).'));
    return;
  }

  const hasGh = checkGhCli();
  if (!hasGh) {
    console.log(chalk.yellow('\n⚠ `gh` CLI not found. Skipping PR creation.'));
    console.log(chalk.dim('Install it: https://cli.github.com/'));
    return;
  }

  if (isDryRun) {
    console.log(chalk.yellow(`\n[dry-run] Would offer to create PR for branch ${branchName}`));
    return;
  }

  // Check if there are any commits to push
  try {
    const diffStat = execSync(`git diff --stat origin/${getDefaultBranch(workDir)}..HEAD`, {
      cwd: workDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    if (!diffStat) {
      console.log(chalk.yellow('\nNo new commits to push. Skipping PR creation.'));
      return;
    }
  } catch {
    // If the comparison fails, still offer PR creation
  }

  console.log('');
  const { createPr } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'createPr',
      message: 'Create a PR?',
      default: true,
    },
  ]);

  if (!createPr) {
    console.log(chalk.dim('Skipping PR. You can create one later with `gh pr create`.'));
    return;
  }

  // Push the branch first
  console.log(chalk.dim('Pushing branch...'));
  try {
    execSync(`git push -u origin ${branchName}`, {
      cwd: workDir,
      stdio: 'inherit',
    });
  } catch (err: any) {
    console.error(chalk.red(`Failed to push branch: ${err.message}`));
    return;
  }

  // Build PR body
  const bodySummary = bodyText
    ? bodyText.slice(0, 500) + (bodyText.length > 500 ? '...' : '')
    : detail.title;

  const prBody = `Implements: ${notionUrl}\n\n${bodySummary}`;
  const prTitle = detail.title;

  try {
    const prUrl = execSync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --head ${branchName} --repo ${targetRepo}`,
      {
        cwd: workDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      }
    ).trim();

    console.log(chalk.green(`\n✅ PR created: ${chalk.underline.blue(prUrl)}`));
  } catch (err: any) {
    console.error(chalk.red(`\nFailed to create PR: ${err.message}`));
    console.log(chalk.dim('You can create one manually with: gh pr create'));
  }

  console.log('');
}
