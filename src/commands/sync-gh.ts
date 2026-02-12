import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { getUnresolvedCommentCount, parsePRUrl } from '../lib/github';
import { loadSyncedTickets, saveSyncedTickets, hasSyncedTickets, saveCachedPRs } from '../lib/ticket-store';
import type { CachedPR } from '../types';

function extractTicketId(title: string): string {
  const match = title.match(/^\[?([A-Za-z]+-\d+)\]?/i);
  return match ? match[1].toUpperCase() : '';
}

export async function syncGhCommand(): Promise<void> {
  const config = loadConfig();

  if (!config.githubOrg) {
    console.log(chalk.red('No githubOrg configured. Run `tix setup` first.'));
    return;
  }

  if (!hasSyncedTickets()) {
    console.log(chalk.yellow('No cached tickets found. Run `tix sync` first to fetch tickets from Notion.'));
    return;
  }

  const tickets = loadSyncedTickets();
  if (tickets.length === 0) {
    console.log(chalk.yellow('No tickets in cache. Run `tix sync` to refresh.'));
    return;
  }

  console.log(chalk.bold.cyan(`\n🔍 Syncing GitHub PRs (org: ${config.githubOrg})\n`));

  // Fetch all open PRs by the user in one call
  let username: string;
  try {
    username = execSync('gh api user --jq .login', { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    console.log(chalk.red('Could not get GitHub username. Run `gh auth login`.'));
    return;
  }

  process.stdout.write(chalk.dim(`  Fetching open PRs by ${username}...\n`));

  let allPrs: Array<{ number: number; title: string; url: string; repository: { nameWithOwner: string }; updatedAt: string }>;
  try {
    const result = execSync(
      `gh search prs --author "${username}" --state open --owner "${config.githubOrg}" --json number,title,url,repository,updatedAt --limit 100`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    allPrs = JSON.parse(result);
  } catch {
    console.log(chalk.red('Failed to fetch PRs from GitHub.'));
    return;
  }

  console.log(chalk.dim(`  Found ${allPrs.length} open PR(s)\n`));

  // Build ticket number map (both TN- and NT- variants)
  const ticketMap = new Map<string, number>();
  for (let i = 0; i < tickets.length; i++) {
    const tn = tickets[i].ticketNumber;
    if (!tn) continue;
    ticketMap.set(tn.toUpperCase(), i);
    if (tn.startsWith('TN-')) ticketMap.set(tn.replace('TN-', 'NT-').toUpperCase(), i);
    if (tn.startsWith('NT-')) ticketMap.set(tn.replace('NT-', 'TN-').toUpperCase(), i);
  }

  // Fetch review status and comments for each PR
  process.stdout.write(chalk.dim(`  Checking review status and comments...\n`));

  const cachedPRs: CachedPR[] = [];
  let linkedCount = 0;
  const matchedTickets = new Set<number>();

  for (const pr of allPrs) {
    const repo = pr.repository.nameWithOwner;
    const parsed = parsePRUrl(pr.url);
    const ticketId = extractTicketId(pr.title);

    // Fetch review decision
    let reviewDecision = '';
    if (parsed) {
      try {
        reviewDecision = execSync(
          `gh pr view ${parsed.number} --repo ${repo} --json reviewDecision --jq .reviewDecision`,
          { stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
      } catch { /* ignore */ }
    }

    // Fetch unresolved comments
    let unresolvedComments = 0;
    if (parsed) {
      unresolvedComments = getUnresolvedCommentCount(parsed.owner, parsed.repo, parsed.number);
    }

    cachedPRs.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      repo,
      ticketId,
      reviewDecision,
      unresolvedComments,
      updatedAt: pr.updatedAt,
    });

    // Link PR to ticket cache
    const ticketIdx = ticketMap.get(ticketId);
    if (ticketIdx !== undefined) {
      const ticket = tickets[ticketIdx];
      const existing = new Set(ticket.githubLinks || []);
      if (!existing.has(pr.url)) {
        existing.add(pr.url);
        ticket.githubLinks = [...existing];
        linkedCount++;
      }
      matchedTickets.add(ticketIdx);
    }

    const commentStr = unresolvedComments === 0
      ? chalk.green('✓')
      : unresolvedComments <= 2
        ? chalk.yellow(`${unresolvedComments}`)
        : chalk.red(`${unresolvedComments}`);
    const repoShort = repo.includes('/') ? repo.split('/')[1] : repo;
    console.log(chalk.dim(`  #${pr.number} ${repoShort} `) + commentStr);
  }

  saveCachedPRs(cachedPRs);
  saveSyncedTickets(tickets);

  console.log(chalk.green(`\n✓ Cached ${cachedPRs.length} PR(s), linked ${linkedCount} to ${matchedTickets.size} ticket(s)\n`));
}
