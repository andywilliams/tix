import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig, hasNotionApiConfig } from '../lib/config';
import { createNotionClient, queryMyTickets } from '../lib/notion';
import { getPRInfo, parsePRUrl } from '../lib/github';
import { loadSyncedTickets, hasSyncedTickets, getSyncTimestamp } from '../lib/ticket-store';

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

export async function statusCommand(): Promise<void> {
  const config = loadConfig();

  console.log(chalk.bold.cyan(`\n📋 Tickets for ${config.userName}\n`));

  if (!hasNotionApiConfig(config)) {
    // Sync mode: use cached tickets
    if (!hasSyncedTickets()) {
      console.log(chalk.yellow('No cached tickets found. Run `tix sync` first to fetch tickets via Claude CLI.'));
      return;
    }

    const tickets = loadSyncedTickets();
    const syncTime = getSyncTimestamp();

    if (tickets.length === 0) {
      console.log(chalk.yellow('No tickets in cache. Run `tix sync` to refresh.'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('Title'),
        chalk.bold('Status'),
        chalk.bold('Priority'),
        chalk.bold('Updated'),
      ],
      colWidths: [42, 16, 14, 12],
      wordWrap: true,
      style: {
        head: [],
        border: ['dim'],
      },
    });

    for (const ticket of tickets) {
      table.push([
        ticket.title.length > 39 ? ticket.title.slice(0, 36) + '...' : ticket.title,
        colorStatus(ticket.status),
        formatPriority(ticket.priority),
        ticket.lastUpdated,
      ]);
    }

    console.log(table.toString());
    console.log(chalk.dim(`\n${tickets.length} ticket(s) from cache`));
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

  let tickets;
  try {
    tickets = await queryMyTickets(notion, config);
  } finally {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  if (tickets.length === 0) {
    console.log(chalk.yellow('No tickets found. Check your config with `tix setup`.'));
    console.log(chalk.dim('Tip: Use `tix inspect <database-url>` to check property names.'));
    return;
  }

  // Fetch PR info for tickets with GitHub links
  process.stdout.write(chalk.dim('Checking PRs for unresolved comments...\n'));

  const ticketPRComments: Map<string, number> = new Map();
  const ticketPRCount: Map<string, number> = new Map();

  for (const ticket of tickets) {
    const prLinks = ticket.githubLinks.filter((l: string) => parsePRUrl(l));
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
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('PRs'),
      chalk.bold('Comments'),
      chalk.bold('Updated'),
    ],
    colWidths: [38, 16, 14, 6, 10, 12],
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
      ticket.title.length > 35 ? ticket.title.slice(0, 32) + '...' : ticket.title,
      colorStatus(ticket.status),
      formatPriority(ticket.priority),
      prsCell,
      commentsCell,
      ticket.lastUpdated,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\n${tickets.length} ticket(s) found\n`));
}
