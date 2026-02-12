import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { parsePRUrl } from '../lib/github';
import { loadSyncedTickets, saveSyncedTickets, hasSyncedTickets } from '../lib/ticket-store';

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

  console.log(chalk.bold.cyan(`\n🔍 Searching GitHub for PRs (org: ${config.githubOrg})\n`));

  // Fetch all open PRs by the user in one call instead of searching per ticket
  let username: string;
  try {
    username = execSync('gh api user --jq .login', { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    console.log(chalk.red('Could not get GitHub username. Run `gh auth login`.'));
    return;
  }

  process.stdout.write(chalk.dim(`  Fetching open PRs by ${username}...\n`));

  let allPrs: Array<{ number: number; title: string; url: string; repository: { nameWithOwner: string } }>;
  try {
    const result = execSync(
      `gh search prs --author "${username}" --state open --owner "${config.githubOrg}" --json number,title,url,repository --limit 100`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    allPrs = JSON.parse(result);
  } catch {
    console.log(chalk.red('Failed to fetch PRs from GitHub.'));
    return;
  }

  console.log(chalk.dim(`  Found ${allPrs.length} open PR(s), matching to tickets...\n`));

  // Build a map from ticket number (both TN- and NT- variants) to ticket index
  const ticketMap = new Map<string, number>();
  for (let i = 0; i < tickets.length; i++) {
    const tn = tickets[i].ticketNumber;
    if (!tn) continue;
    ticketMap.set(tn.toUpperCase(), i);
    // Also map the alternate prefix
    if (tn.startsWith('TN-')) ticketMap.set(tn.replace('TN-', 'NT-').toUpperCase(), i);
    if (tn.startsWith('NT-')) ticketMap.set(tn.replace('NT-', 'TN-').toUpperCase(), i);
  }

  let found = 0;
  const matchedTickets = new Set<number>();

  for (const pr of allPrs) {
    // Extract ticket ID from PR title
    const match = pr.title.match(/\[?([A-Za-z]+-\d+)\]?/i);
    if (!match) continue;

    const ticketId = match[1].toUpperCase();
    const ticketIdx = ticketMap.get(ticketId);
    if (ticketIdx === undefined) continue;

    const ticket = tickets[ticketIdx];
    const existing = new Set(ticket.githubLinks || []);
    if (!existing.has(pr.url)) {
      existing.add(pr.url);
      ticket.githubLinks = [...existing];
      found++;
    }
    matchedTickets.add(ticketIdx);
  }

  // Print results per ticket
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (!ticket.ticketNumber) continue;
    const prCount = (ticket.githubLinks || []).filter(l => parsePRUrl(l)).length;
    if (matchedTickets.has(i)) {
      console.log(chalk.dim(`  ${ticket.ticketNumber} `) + chalk.green(`${prCount} PR(s)`));
    }
  }

  saveSyncedTickets(tickets);
  console.log(chalk.green(`\n✓ Linked ${found} new PR(s) across ${matchedTickets.size} ticket(s)\n`));
}
