import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig, hasNotionApiConfig } from '../lib/config';
import { createNotionClient, queryMyTickets } from '../lib/notion';
import { getPRInfo, parsePRUrl, searchPRsByTicketId } from '../lib/github';
import { loadSyncedTickets, hasSyncedTickets, getSyncTimestamp } from '../lib/ticket-store';
import { loadStatusSettings, saveStatusSettings } from '../lib/review-config';
import type { CompletedPeriod, TicketSummary } from '../types';

const STATUS_COLORS: Record<string, (s: string) => string> = {
  // Done / Complete
  'done': chalk.green,
  'complete': chalk.green,
  'completed': chalk.green,
  'shipped': chalk.green,
  'released': chalk.green,
  'closed': chalk.green,

  // In Progress
  'in progress': chalk.yellow,
  'in-progress': chalk.yellow,
  'doing': chalk.yellow,
  'active': chalk.yellow,
  'wip': chalk.yellow,
  'in review': chalk.yellow,
  'review': chalk.yellow,

  // Blocked
  'blocked': chalk.red,
  'on hold': chalk.red,
  'stuck': chalk.red,

  // To Do / Not Started
  'to do': chalk.blue,
  'todo': chalk.blue,
  'not started': chalk.blue,
  'backlog': chalk.dim,
  'icebox': chalk.dim,
};

const PRIORITY_ICONS: Record<string, string> = {
  'urgent': '🔴',
  'critical': '🔴',
  'p0': '🔴',
  'high': '🟠',
  'p1': '🟠',
  'medium': '🟡',
  'p2': '🟡',
  'low': '🟢',
  'p3': '🟢',
  'none': '⚪',
};

function colorStatus(status: string): string {
  const colorFn = STATUS_COLORS[status.toLowerCase()];
  return colorFn ? colorFn(status) : chalk.white(status);
}

function formatPriority(priority: string): string {
  const icon = PRIORITY_ICONS[priority.toLowerCase()] || '⚪';
  return `${icon} ${priority}`;
}

function formatComments(count: number): string {
  if (count === 0) return chalk.green('✓');
  if (count <= 2) return chalk.yellow(`${count}`);
  return chalk.red(`${count}`);
}

const COMPLETED_STATUSES = new Set([
  'done', 'complete', 'completed', 'shipped', 'released', 'closed', "won't do", 'wont do',
]);

const PERIOD_DAYS: Record<CompletedPeriod, number> = {
  none: 0,
  week: 7,
  '2weeks': 14,
  month: 30,
  quarter: 90,
  year: 365,
};

const PERIOD_LABELS: Record<CompletedPeriod, string> = {
  none: '',
  week: '1 week',
  '2weeks': '2 weeks',
  month: '1 month',
  quarter: '1 quarter',
  year: '1 year',
};

function filterCompletedTickets(tickets: TicketSummary[], period: CompletedPeriod): { filtered: TicketSummary[]; hiddenCount: number } {
  const now = Date.now();
  let hiddenCount = 0;
  const filtered = tickets.filter((ticket) => {
    const isCompleted = COMPLETED_STATUSES.has(ticket.status.toLowerCase());
    if (!isCompleted) return true;
    if (period === 'none') {
      hiddenCount++;
      return false;
    }
    const cutoffMs = PERIOD_DAYS[period] * 24 * 60 * 60 * 1000;
    const updated = new Date(ticket.lastUpdated).getTime();
    if (isNaN(updated) || now - updated > cutoffMs) {
      hiddenCount++;
      return false;
    }
    return true;
  });
  return { filtered, hiddenCount };
}

export async function statusCommand(options: { completed?: string } = {}): Promise<void> {
  const config = loadConfig();

  const statusSettings = loadStatusSettings();
  const period: CompletedPeriod = (options.completed as CompletedPeriod) || statusSettings.completedPeriod;

  if (options.completed) {
    saveStatusSettings({ completedPeriod: period });
  }

  console.log(chalk.bold.cyan(`\n📋 Tickets for ${config.userName}\n`));

  if (!hasNotionApiConfig(config)) {
    // Sync mode: use cached tickets
    if (!hasSyncedTickets()) {
      console.log(chalk.yellow('No cached tickets found. Run `tix sync` first to fetch tickets via Claude CLI.'));
      return;
    }

    const allTickets = loadSyncedTickets();
    const syncTime = getSyncTimestamp();

    if (allTickets.length === 0) {
      console.log(chalk.yellow('No tickets in cache. Run `tix sync` to refresh.'));
      return;
    }

    const { filtered: tickets, hiddenCount } = filterCompletedTickets(allTickets, period);

    // Use cached githubLinks (populated by `tix sync-gh`)
    const ticketPRComments: Map<string, number> = new Map();
    const ticketPRCount: Map<string, number> = new Map();

    const ticketsWithPRs = tickets.filter(t => {
      const prLinks = (t.githubLinks || []).filter((l: string) => parsePRUrl(l));
      return prLinks.length > 0;
    });

    if (ticketsWithPRs.length > 0) {
      process.stdout.write(chalk.dim('Checking PRs for unresolved comments...\n'));

      for (const ticket of ticketsWithPRs) {
        const prLinks = ticket.githubLinks.filter((l: string) => parsePRUrl(l));
        ticketPRCount.set(ticket.id, prLinks.length);
        let totalUnresolved = 0;

        for (const prUrl of prLinks) {
          const prInfo = await getPRInfo(prUrl);
          if (prInfo) {
            totalUnresolved += prInfo.unresolvedComments;
          }
        }

        ticketPRComments.set(ticket.id, totalUnresolved);
      }
    }

    const hasPRData = ticketPRCount.size > 0;

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Title'),
        chalk.bold('Status'),
        chalk.bold('Priority'),
        ...(hasPRData ? [chalk.bold('PRs'), chalk.bold('Comments')] : []),
        chalk.bold('Updated'),
      ],
      colWidths: hasPRData ? [12, 28, 16, 14, 6, 10, 12] : [12, 32, 16, 14, 12],
      wordWrap: true,
      style: {
        head: [],
        border: ['dim'],
      },
    });

    for (const ticket of tickets) {
      const prCount = ticketPRCount.get(ticket.id) || 0;
      const commentCount = ticketPRComments.get(ticket.id);
      const titleMax = hasPRData ? 25 : 29;
      const titleTrunc = hasPRData ? 22 : 26;

      const row = [
        ticket.ticketNumber || '—',
        ticket.title.length > titleMax ? ticket.title.slice(0, titleTrunc) + '...' : ticket.title,
        colorStatus(ticket.status),
        formatPriority(ticket.priority),
      ];

      if (hasPRData) {
        row.push(
          prCount === 0 ? chalk.dim('—') : chalk.cyan(`${prCount}`),
          prCount === 0 ? chalk.dim('—') : formatComments(commentCount ?? 0),
        );
      }

      row.push(ticket.lastUpdated);
      table.push(row);
    }

    console.log(table.toString());
    console.log(chalk.dim(`\n${tickets.length} ticket(s) from cache`));
    if (hiddenCount > 0) {
      console.log(chalk.dim(`Hiding ${hiddenCount} completed ticket(s) older than ${PERIOD_LABELS[period]}`));
    }
    if (syncTime) {
      console.log(chalk.dim(`Last synced: ${syncTime.toLocaleString()}`));
    }
    console.log(chalk.dim('Run `tix sync` to refresh.\n'));
    return;
  }

  // API mode: fetch directly from Notion
  const notion = createNotionClient(config);

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${spinner[i % spinner.length]} Fetching from Notion...`);
    i++;
  }, 80);

  let allApiTickets;
  try {
    allApiTickets = await queryMyTickets(notion, config);
  } finally {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  if (allApiTickets.length === 0) {
    console.log(chalk.yellow('No tickets found. Check your config with `tix setup`.'));
    console.log(chalk.dim('Tip: Use `tix inspect <database-url>` to check property names.'));
    return;
  }

  const { filtered: tickets, hiddenCount } = filterCompletedTickets(allApiTickets, period);

  // Fetch PR info for tickets with GitHub links
  process.stdout.write(chalk.dim('Checking PRs for unresolved comments...\n'));

  const ticketPRComments: Map<string, number> = new Map();
  const ticketPRCount: Map<string, number> = new Map();

  for (const ticket of tickets) {
    let prLinks = ticket.githubLinks.filter((l: string) => parsePRUrl(l));
    if (prLinks.length === 0 && ticket.ticketNumber && config.githubOrg) {
      prLinks = searchPRsByTicketId(config.githubOrg, ticket.ticketNumber);
    }
    if (prLinks.length === 0) continue;

    ticketPRCount.set(ticket.id, prLinks.length);
    let totalUnresolved = 0;

    for (const prUrl of prLinks) {
      const prInfo = await getPRInfo(prUrl);
      if (prInfo) {
        totalUnresolved += prInfo.unresolvedComments;
      }
    }

    ticketPRComments.set(ticket.id, totalUnresolved);
  }

  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('PRs'),
      chalk.bold('Comments'),
      chalk.bold('Updated'),
    ],
    colWidths: [12, 28, 16, 14, 6, 10, 12],
    wordWrap: true,
    style: {
      head: [],
      border: ['dim'],
    },
  });

  for (const ticket of tickets) {
    const prCount = ticketPRCount.get(ticket.id) || 0;
    const commentCount = ticketPRComments.get(ticket.id);
    const commentsCell = prCount === 0
      ? chalk.dim('—')
      : formatComments(commentCount ?? 0);
    const prsCell = prCount === 0
      ? chalk.dim('—')
      : chalk.cyan(`${prCount}`);

    table.push([
      ticket.ticketNumber || '—',
      ticket.title.length > 25 ? ticket.title.slice(0, 22) + '...' : ticket.title,
      colorStatus(ticket.status),
      formatPriority(ticket.priority),
      prsCell,
      commentsCell,
      ticket.lastUpdated,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\n${tickets.length} ticket(s) found`));
  if (hiddenCount > 0) {
    console.log(chalk.dim(`Hiding ${hiddenCount} completed ticket(s) older than ${PERIOD_LABELS[period]}`));
  }
  console.log('');
}
