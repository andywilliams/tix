import chalk from 'chalk';
import Table from 'cli-table3';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { checkGhCli, getUnresolvedCommentCount, parsePRUrl } from '../lib/github';

interface SearchPR {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  state: string;
  updatedAt: string;
}

function extractTicketId(title: string): string {
  const match = title.match(/^\[?([A-Za-z]+-\d+)\]?/i);
  return match ? match[1].toUpperCase() : '';
}

function reviewIcon(decision: string): string {
  switch (decision) {
    case 'APPROVED': return chalk.green('✓ approved');
    case 'CHANGES_REQUESTED': return chalk.red('✗ changes');
    case 'REVIEW_REQUIRED': return chalk.yellow('◐ pending');
    default: return chalk.dim('—');
  }
}

export async function prsCommand(): Promise<void> {
  if (!checkGhCli()) {
    console.log(chalk.red('`gh` CLI not found or not authenticated. Run `gh auth login`.'));
    return;
  }

  const config = loadConfig();

  console.log(chalk.bold.cyan('\n🔀 Open Pull Requests\n'));

  let username: string;
  try {
    username = execSync('gh api user --jq .login', { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    console.log(chalk.red('Could not determine GitHub username.'));
    return;
  }

  process.stdout.write(chalk.dim(`Searching for open PRs by ${username}...\n`));

  let prs: SearchPR[];
  try {
    const ownerFlag = config.githubOrg ? `--owner "${config.githubOrg}"` : '';
    const result = execSync(
      `gh search prs --author "${username}" --state open ${ownerFlag} --json number,title,url,repository,state,updatedAt --limit 50`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    prs = JSON.parse(result);
  } catch (err: any) {
    const msg = err.stderr?.toString() || err.message || '';
    if (msg.includes('401') || msg.includes('Bad credentials')) {
      console.log(chalk.red('GitHub auth expired. Run `gh auth login`.'));
    } else {
      console.log(chalk.red(`Failed to search PRs: ${msg.trim()}`));
    }
    return;
  }

  if (prs.length === 0) {
    console.log(chalk.yellow('No open PRs found.'));
    return;
  }

  process.stdout.write(chalk.dim(`Checking unresolved comments...\n\n`));

  const table = new Table({
    head: [
      chalk.bold('#'),
      chalk.bold('Ticket'),
      chalk.bold('Repo'),
      chalk.bold('Title'),
      chalk.bold('Review'),
      chalk.bold('Comments'),
      chalk.bold('Updated'),
    ],
    colWidths: [8, 12, 22, 28, 14, 10, 12],
    wordWrap: true,
    style: { head: [], border: ['dim'] },
  });

  for (const pr of prs) {
    const ticketId = extractTicketId(pr.title);
    const repo = pr.repository.nameWithOwner;
    const parsed = parsePRUrl(pr.url);
    let unresolvedComments = 0;
    let reviewDecision = '';
    if (parsed) {
      unresolvedComments = getUnresolvedCommentCount(parsed.owner, parsed.repo, parsed.number);
      try {
        reviewDecision = execSync(
          `gh pr view ${parsed.number} --repo ${repo} --json reviewDecision --jq .reviewDecision`,
          { stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
      } catch {
        // ignore
      }
    }

    const commentsCell = unresolvedComments === 0
      ? chalk.green('✓')
      : unresolvedComments <= 2
        ? chalk.yellow(`${unresolvedComments}`)
        : chalk.red(`${unresolvedComments}`);

    const updated = new Date(pr.updatedAt);
    const dateStr = updated.toISOString().slice(0, 10);

    table.push([
      chalk.cyan(`${pr.number}`),
      ticketId ? chalk.white(ticketId) : chalk.dim('—'),
      repo.includes('/') ? repo.split('/')[1] : repo,
      pr.title.length > 25 ? pr.title.slice(0, 22) + '...' : pr.title,
      reviewIcon(reviewDecision),
      commentsCell,
      dateStr,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\n${prs.length} open PR(s)\n`));
}
