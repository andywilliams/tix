import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../lib/config';
import { createNotionClient, queryMyTickets } from '../lib/notion';

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

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const notion = createNotionClient(config);

  console.log(chalk.bold.cyan(`\n📋 Tickets for ${config.userName}\n`));

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
    console.log(chalk.yellow('No tickets found. Check your config with `eq setup`.'));
    console.log(chalk.dim('Tip: Use `eq inspect <database-url>` to check property names.'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('Updated'),
    ],
    colWidths: [45, 18, 16, 14],
    wordWrap: true,
    style: {
      head: [],
      border: ['dim'],
    },
  });

  for (const ticket of tickets) {
    table.push([
      ticket.title.length > 42 ? ticket.title.slice(0, 39) + '...' : ticket.title,
      colorStatus(ticket.status),
      formatPriority(ticket.priority),
      ticket.lastUpdated,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\n${tickets.length} ticket(s) found\n`));
}
