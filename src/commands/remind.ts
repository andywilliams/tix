import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config';
import type { EqConfig } from '../types';

interface ReminderOptions {
  at?: string;
  in?: string;
  list?: boolean;
  delete?: string;
  clear?: boolean;
}

const DEFAULT_BASE_URL = 'http://localhost:3001/api';

// Parse duration string (e.g. "1d", "2h", "30m") to milliseconds
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like "30m", "2h", "1d"`);
  }

  const [, num, unit] = match;
  const value = parseInt(num, 10);

  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

// Parse datetime string to Date
function parseDatetime(datetime: string): Date {
  const date = new Date(datetime);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid datetime format: ${datetime}. Use ISO format like "2026-03-12" or "2026-03-12T14:30"`);
  }
  if (date.getTime() < Date.now()) {
    throw new Error('Reminder time must be in the future');
  }
  return date;
}

// Format relative time for display
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const minutes = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));

  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else if (hours < 24) {
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  } else {
    return `${days} day${days !== 1 ? 's' : ''}`;
  }
}

// Fetch reminders from API
async function fetchReminders(baseUrl: string): Promise<any[]> {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(`${baseUrl}/reminders`);
  if (!response.ok) {
    throw new Error(`Failed to fetch reminders: ${response.statusText}`);
  }
  const data = await response.json();
  return data.reminders || [];
}

// Create a reminder via API
async function createReminderApi(baseUrl: string, message: string, remindAt: Date, taskId?: string): Promise<any> {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(`${baseUrl}/reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      remindAt: remindAt.toISOString(),
      taskId
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create reminder: ${error}`);
  }

  const data = await response.json();
  return data.reminder;
}

// Delete a reminder via API
async function deleteReminderApi(baseUrl: string, reminderId: string): Promise<void> {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(`${baseUrl}/reminders/${reminderId}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(`Failed to delete reminder: ${response.statusText}`);
  }
}

// Clear triggered reminders via API
async function clearTriggeredRemindersApi(baseUrl: string): Promise<void> {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(`${baseUrl}/reminders/clear-triggered`, {
    method: 'POST'
  });

  if (!response.ok) {
    throw new Error(`Failed to clear triggered reminders: ${response.statusText}`);
  }
}

export async function remindCommand(message: string | undefined, options: ReminderOptions): Promise<void> {
  const config = loadConfig();
  const baseUrl = process.env.TIX_KANBAN_URL || DEFAULT_BASE_URL;

  console.log(chalk.bold.cyan('\n🔔 tix remind — Personal Reminders\n'));

  // Handle list option
  if (options.list) {
    await listReminders(baseUrl);
    return;
  }

  // Handle delete option
  if (options.delete) {
    await deleteReminderApi(baseUrl, options.delete);
    console.log(chalk.green(`✅ Reminder deleted`));
    return;
  }

  // Handle clear option
  if (options.clear) {
    await clearTriggeredRemindersApi(baseUrl);
    console.log(chalk.green(`✅ Triggered reminders cleared`));
    return;
  }

  // If no message provided, show interactive mode
  if (!message) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'List all reminders', value: 'list' },
          { name: 'Create a new reminder', value: 'create' },
          { name: 'Clear triggered reminders', value: 'clear' }
        ]
      }
    ]);

    if (action === 'list') {
      await listReminders(baseUrl);
      return;
    }

    if (action === 'clear') {
      await clearTriggeredRemindersApi(baseUrl);
      console.log(chalk.green(`✅ Triggered reminders cleared`));
      return;
    }

    // Create new reminder interactively
    await createReminderInteractive(baseUrl);
    return;
  }

  // Validate time options
  if (!options.at && !options.in) {
    console.error(chalk.red('Error: Please specify either --at <datetime> or --in <duration>'));
    console.log(chalk.dim('Examples:'));
    console.log(chalk.dim('  tix remind "Follow up on PR #73" --at 2026-03-12'));
    console.log(chalk.dim('  tix remind "Check deployment" --in 1d'));
    process.exit(1);
  }

  if (options.at && options.in) {
    console.error(chalk.red('Error: Please specify only one of --at or --in, not both'));
    process.exit(1);
  }

  // Calculate reminder time
  let remindAt: Date;

  if (options.at) {
    remindAt = parseDatetime(options.at);
  } else if (options.in) {
    const durationMs = parseDuration(options.in);
    remindAt = new Date(Date.now() + durationMs);
  } else {
    // This shouldn't happen due to earlier validation
    console.error(chalk.red('Error: Please specify either --at <datetime> or --in <duration>'));
    process.exit(1);
  }

  // Create the reminder
  try {
    const reminder = await createReminderApi(baseUrl, message, remindAt);
    console.log(chalk.green(`✅ Reminder created:`));
    console.log(`  "${reminder.message}"`);
    console.log(`  Will remind at: ${chalk.yellow(reminder.remindAt)} (in ${formatRelativeTime(new Date(reminder.remindAt))})`);
  } catch (error) {
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    console.error(chalk.dim('Make sure tix-kanban is running: cd /path/to/tix-kanban && npm start'));
    process.exit(1);
  }
}

async function createReminderInteractive(baseUrl: string): Promise<void> {
  const { message } = await inquirer.prompt([
    {
      type: 'input',
      name: 'message',
      message: 'What would you like to be reminded about?',
      validate: (input: string) => input.trim().length > 0 || 'Please enter a message'
    }
  ]);

  const { timeOption } = await inquirer.prompt([
    {
      type: 'list',
      name: 'timeOption',
      message: 'When should I remind you?',
      choices: [
        { name: 'In X minutes', value: 'minutes' },
        { name: 'In X hours', value: 'hours' },
        { name: 'In X days', value: 'days' },
        { name: 'At a specific date/time', value: 'specific' }
      ]
    }
  ]);

  let remindAt: Date;

  if (timeOption === 'minutes') {
    const { minutes } = await inquirer.prompt([
      {
        type: 'input',
        name: 'minutes',
        message: 'How many minutes from now?',
        validate: (input: string) => {
          const num = parseInt(input, 10);
          return !isNaN(num) && num > 0 || 'Please enter a positive number';
        },
        filter: (input: string) => parseInt(input, 10)
      }
    ]);
    remindAt = new Date(Date.now() + minutes * 60 * 1000);
  } else if (timeOption === 'hours') {
    const { hours } = await inquirer.prompt([
      {
        type: 'input',
        name: 'hours',
        message: 'How many hours from now?',
        validate: (input: string) => {
          const num = parseInt(input, 10);
          return !isNaN(num) && num > 0 || 'Please enter a positive number';
        },
        filter: (input: string) => parseInt(input, 10)
      }
    ]);
    remindAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  } else if (timeOption === 'days') {
    const { days } = await inquirer.prompt([
      {
        type: 'input',
        name: 'days',
        message: 'How many days from now?',
        validate: (input: string) => {
          const num = parseInt(input, 10);
          return !isNaN(num) && num > 0 || 'Please enter a positive number';
        },
        filter: (input: string) => parseInt(input, 10)
      }
    ]);
    remindAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  } else {
    const { datetime } = await inquirer.prompt([
      {
        type: 'input',
        name: 'datetime',
        message: 'Enter date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM):',
        validate: (input: string) => {
          try {
            const date = new Date(input);
            return !isNaN(date.getTime()) && date.getTime() > Date.now() || 'Please enter a valid future date/time';
          } catch {
            return false;
          }
        }
      }
    ]);
    remindAt = parseDatetime(datetime);
  }

  try {
    const reminder = await createReminderApi(baseUrl, message, remindAt);
    console.log(chalk.green(`\n✅ Reminder created:`));
    console.log(`  "${reminder.message}"`);
    console.log(`  Will remind at: ${chalk.yellow(reminder.remindAt)} (in ${formatRelativeTime(new Date(reminder.remindAt))})`);
  } catch (error) {
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    process.exit(1);
  }
}

async function listReminders(baseUrl: string): Promise<void> {
  try {
    const reminders = await fetchReminders(baseUrl);

    if (reminders.length === 0) {
      console.log(chalk.yellow('No reminders found.'));
      return;
    }

    // Separate active and triggered
    const active = reminders.filter((r: any) => !r.triggered);
    const triggered = reminders.filter((r: any) => r.triggered);

    if (active.length > 0) {
      console.log(chalk.bold('\n📌 Active Reminders:\n'));
      for (const reminder of active) {
        const remindAt = new Date(reminder.remindAt);
        const taskRef = reminder.taskId ? chalk.dim(` [task: ${reminder.taskId}]`) : '';
        console.log(`  ${chalk.cyan('•')} ${reminder.message}${taskRef}`);
        console.log(`    ${chalk.dim('Due:')} ${chalk.yellow(remindAt.toLocaleString())} (in ${formatRelativeTime(remindAt)})`);
        console.log(`    ${chalk.dim('ID:')} ${chalk.gray(reminder.id)}`);
        console.log();
      }
    }

    if (triggered.length > 0) {
      console.log(chalk.bold('\n✅ Previously Triggered:\n'));
      for (const reminder of triggered.slice(0, 5)) { // Show last 5
        const remindAt = new Date(reminder.remindAt);
        console.log(`  ${chalk.gray('•')} ${reminder.message}`);
        console.log(`    ${chalk.gray('Triggered at:')} ${remindAt.toLocaleString()}`);
        console.log();
      }
      if (triggered.length > 5) {
        console.log(chalk.dim(`  ... and ${triggered.length - 5} more (use --clear to remove)`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    console.error(chalk.dim('Make sure tix-kanban is running: cd /path/to/tix-kanban && npm start'));
    process.exit(1);
  }
}
