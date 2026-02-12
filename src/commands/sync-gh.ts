import chalk from 'chalk';
import { loadConfig } from '../lib/config';
import { searchPRsByTicketId, parsePRUrl } from '../lib/github';
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

  let found = 0;
  for (const ticket of tickets) {
    if (!ticket.ticketNumber) continue;

    process.stdout.write(chalk.dim(`  ${ticket.ticketNumber}... `));
    const prUrls = searchPRsByTicketId(config.githubOrg, ticket.ticketNumber);

    if (prUrls.length > 0) {
      // Merge with existing links, deduplicating
      const existing = new Set(ticket.githubLinks || []);
      for (const url of prUrls) {
        existing.add(url);
      }
      ticket.githubLinks = [...existing];
      found += prUrls.length;
      console.log(chalk.green(`${prUrls.length} PR(s)`));
    } else {
      console.log(chalk.dim('none'));
    }
  }

  saveSyncedTickets(tickets);
  console.log(chalk.green(`\n✓ Found ${found} PR(s) across ${tickets.length} ticket(s)\n`));
}
