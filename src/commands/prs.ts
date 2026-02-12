import chalk from 'chalk';
import Table from 'cli-table3';
import { loadSyncedTickets, loadCachedPRs, hasCachedPRs, getPRsSyncTimestamp } from '../lib/ticket-store';

function reviewIcon(decision: string): string {
  switch (decision) {
    case 'APPROVED': return chalk.green('✓ approved');
    case 'CHANGES_REQUESTED': return chalk.red('✗ changes');
    case 'REVIEW_REQUIRED': return chalk.yellow('◐ pending');
    default: return chalk.dim('—');
  }
}

function formatComments(count: number): string {
  if (count === 0) return chalk.green('✓');
  if (count <= 2) return chalk.yellow(`${count}`);
  return chalk.red(`${count}`);
}

export async function prsCommand(): Promise<void> {
  if (!hasCachedPRs()) {
    console.log(chalk.yellow('No cached PR data. Run `tix sync-gh` first.'));
    return;
  }

  const prs = loadCachedPRs();
  if (prs.length === 0) {
    console.log(chalk.yellow('No open PRs in cache. Run `tix sync-gh` to refresh.'));
    return;
  }

  console.log(chalk.bold.cyan('\n🔀 Open Pull Requests\n'));

  // Build set of known ticket numbers from cache
  const cachedTickets = loadSyncedTickets();
  const knownTicketNumbers = new Set<string>();
  for (const t of cachedTickets) {
    if (!t.ticketNumber) continue;
    const upper = t.ticketNumber.toUpperCase();
    knownTicketNumbers.add(upper);
    if (upper.startsWith('TN-')) knownTicketNumbers.add(upper.replace('TN-', 'NT-'));
    if (upper.startsWith('NT-')) knownTicketNumbers.add(upper.replace('NT-', 'TN-'));
  }

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
    const ticketId = pr.ticketId;
    const isOrphan = ticketId && !knownTicketNumbers.has(ticketId);
    const ticketCell = ticketId
      ? (isOrphan ? chalk.yellow(`${ticketId} ⚠`) : chalk.white(ticketId))
      : chalk.dim('—');

    const repoShort = pr.repo.includes('/') ? pr.repo.split('/')[1] : pr.repo;
    const dateStr = new Date(pr.updatedAt).toISOString().slice(0, 10);

    table.push([
      chalk.cyan(`${pr.number}`),
      ticketCell,
      repoShort,
      pr.title.length > 25 ? pr.title.slice(0, 22) + '...' : pr.title,
      reviewIcon(pr.reviewDecision),
      formatComments(pr.unresolvedComments),
      dateStr,
    ]);
  }

  console.log(table.toString());

  const orphanCount = prs.filter(pr => pr.ticketId && !knownTicketNumbers.has(pr.ticketId)).length;

  console.log(chalk.dim(`\n${prs.length} open PR(s)`));
  if (orphanCount > 0) {
    console.log(chalk.yellow(`⚠ ${orphanCount} PR(s) reference tickets not in your Notion cache — run \`tix sync\` to refresh`));
  }
  const syncTime = getPRsSyncTimestamp();
  if (syncTime) {
    console.log(chalk.dim(`Last synced: ${syncTime.toLocaleString()}`));
  }
  console.log(chalk.dim('Run `tix sync-gh` to refresh.'));
  console.log('');
}
