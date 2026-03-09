import chalk from 'chalk';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import {
  loadRules,
  saveUserRules,
  evaluateRules,
  sendReminderToSlack,
  getHistory,
  clearCooldowns,
  BUILT_IN_RULES,
  snoozeReminder,
  getReminder,
  deleteReminder,
  listReminders,
  getReminderStatus,
  getSnoozePresets,
  type ReminderRule,
  type RuleCondition,
  type RuleAction,
  type ReminderStatus,
} from '../lib/reminder-rules';
import { loadConfig } from '../lib/config';

export async function remindCommand(action: string, ...args: any[]) {
  switch (action) {
    case 'run':
      await runReminders(args[0] === '--dry-run' || args[0] === 'dry-run');
      break;
    case 'rules':
      await listRules();
      break;
    case 'add':
      await addRule();
      break;
    case 'enable':
      await toggleRule(args[0], true);
      break;
    case 'disable':
      await toggleRule(args[0], false);
      break;
    case 'remove':
      await removeRule(args[0]);
      break;
    case 'history':
      await showHistory();
      break;
    case 'reset-cooldowns':
      clearCooldowns();
      console.log(chalk.green('✅ All cooldowns reset'));
      break;
    case 'templates':
      showTemplates();
      break;
    case 'snooze':
      await snoozeCommand(args[0], args.slice(1));
      break;
    case 'list':
      await listCommand(args);
      break;
    case 'show':
      await showCommand(args[0]);
      break;
    case 'delete':
      await deleteCommand(args[0]);
      break;
    default:
      console.error(`Unknown remind action: ${action}`);
      console.log('Available actions: run, rules, add, enable, disable, remove, history, reset-cooldowns, templates, snooze, list, show, delete');
      process.exit(1);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function runReminders(dryRun: boolean = false) {
  if (dryRun) {
    console.log(chalk.blue('🔍 Dry run — no notifications will be sent\n'));
  }

  const matches = evaluateRules({ dryRun });

  if (matches.length === 0) {
    console.log(chalk.green('✅ No reminders triggered — everything looks good!'));
    return;
  }

  console.log(chalk.bold(`\n⏰ ${matches.length} reminder(s) triggered:\n`));

  for (const match of matches) {
    console.log(chalk.yellow(`  [${match.ruleName}]`) + ` ${match.entityId}`);
    // Strip Slack markdown for console display
    const consoleMsg = match.message.replace(/\*/g, '').replace(/_/g, '');
    console.log(`  ${consoleMsg}`);
    console.log();
  }

  if (!dryRun) {
    // Try Slack notification
    try {
      const config = loadConfig();
      const slackMatches = matches.filter(m => {
        const rules = loadRules();
        const rule = rules.find(r => r.id === m.ruleId);
        return rule?.action.type === 'slack';
      });

      if (slackMatches.length > 0 && config.slackWebhook) {
        await sendReminderToSlack(config.slackWebhook, slackMatches);
      } else if (slackMatches.length > 0 && !config.slackWebhook) {
        console.log(chalk.dim('  (No Slack webhook configured — run `tix setup-slack` to enable Slack notifications)'));
      }
    } catch (err: any) {
      console.log(chalk.dim(`  (Could not load config for Slack: ${err.message})`));
    }
  }
}

// ─── List Rules ───────────────────────────────────────────────────────────────

async function listRules() {
  const rules = loadRules();

  if (rules.length === 0) {
    console.log('No reminder rules configured. Run `tix remind add` to create one.');
    return;
  }

  console.log(chalk.bold('\n📋 Reminder Rules\n'));

  const table = new Table({
    head: [
      chalk.cyan('ID'),
      chalk.cyan('Name'),
      chalk.cyan('Target'),
      chalk.cyan('Status'),
      chalk.cyan('Cooldown'),
      chalk.cyan('Built-in'),
    ],
    colWidths: [22, 24, 10, 10, 10, 10],
  });

  for (const rule of rules) {
    table.push([
      rule.id,
      rule.name,
      rule.target,
      rule.enabled ? chalk.green('on') : chalk.red('off'),
      rule.cooldown,
      rule.builtIn ? 'yes' : 'no',
    ]);
  }

  console.log(table.toString());
  console.log();

  for (const rule of rules) {
    console.log(chalk.bold(`  ${rule.name}`) + chalk.dim(` (${rule.id})`));
    console.log(`    ${rule.description}`);
    console.log(`    Conditions: ${rule.conditions.map(c => `${c.field} ${c.operator} ${JSON.stringify(c.value)}`).join(' AND ')}`);
    console.log();
  }
}

// ─── Add Rule (Interactive) ───────────────────────────────────────────────────

async function addRule() {
  console.log(chalk.bold('\n📝 Create a New Reminder Rule\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Rule name:',
      validate: (v: string) => v.length > 0 || 'Name is required',
    },
    {
      type: 'input',
      name: 'description',
      message: 'Description:',
      validate: (v: string) => v.length > 0 || 'Description is required',
    },
    {
      type: 'list',
      name: 'target',
      message: 'What does this rule monitor?',
      choices: [
        { name: 'Tickets (status, priority, age)', value: 'ticket' },
        { name: 'Pull Requests (reviews, activity)', value: 'pr' },
        { name: 'Backlog (count-based)', value: 'backlog' },
      ],
    },
  ]);

  const conditions: RuleCondition[] = [];
  let addMore = true;

  while (addMore) {
    const fieldChoices = answers.target === 'ticket'
      ? ['status', 'priority', 'age', 'ticketNumber', 'title']
      : answers.target === 'pr'
      ? ['reviewDecision', 'unresolvedComments', 'age', 'repo', 'title']
      : ['status', 'count'];

    const condAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'field',
        message: 'Condition field:',
        choices: fieldChoices,
      },
      {
        type: 'list',
        name: 'operator',
        message: 'Operator:',
        choices: ['=', '!=', '>', '<', '>=', '<=', 'in', 'not_in'],
      },
      {
        type: 'input',
        name: 'value',
        message: 'Value (for "in"/"not_in" use comma-separated):',
        validate: (v: string) => v.length > 0 || 'Value is required',
      },
      {
        type: 'confirm',
        name: 'addMore',
        message: 'Add another condition?',
        default: false,
      },
    ]);

    let value: string | number | string[] = condAnswers.value;
    if (['in', 'not_in'].includes(condAnswers.operator)) {
      value = condAnswers.value.split(',').map((s: string) => s.trim());
    } else if (!isNaN(Number(condAnswers.value)) && condAnswers.field !== 'age') {
      value = Number(condAnswers.value);
    }

    conditions.push({
      field: condAnswers.field,
      operator: condAnswers.operator,
      value,
    });

    addMore = condAnswers.addMore;
  }

  const actionAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'type',
      message: 'Notification type:',
      choices: [
        { name: 'Slack', value: 'slack' },
        { name: 'Console only', value: 'console' },
      ],
    },
    {
      type: 'input',
      name: 'message',
      message: 'Message template (use {id}, {title}, {age}, {status}, {url}, {count}, {number}):',
      validate: (v: string) => v.length > 0 || 'Message is required',
    },
    {
      type: 'list',
      name: 'cooldown',
      message: 'Cooldown (prevents duplicate alerts):',
      choices: ['1h', '4h', '12h', '24h', '48h', '7d'],
      default: '24h',
    },
  ]);

  const newRule: ReminderRule = {
    id: `custom-${Date.now().toString(36)}`,
    name: answers.name,
    description: answers.description,
    enabled: true,
    target: answers.target,
    conditions,
    action: {
      type: actionAnswers.type,
      message: actionAnswers.message,
    },
    cooldown: actionAnswers.cooldown,
  };

  // Load existing user rules and add the new one
  const allRules = loadRules();
  const userRules = allRules.filter(r => !r.builtIn);
  userRules.push(newRule);
  saveUserRules(userRules);

  console.log(chalk.green(`\n✅ Rule "${newRule.name}" created (${newRule.id})`));
  console.log(chalk.dim('  Run `tix remind run --dry-run` to test it'));
}

// ─── Toggle Rule ──────────────────────────────────────────────────────────────

async function toggleRule(ruleId: string, enabled: boolean) {
  if (!ruleId) {
    console.error(`Usage: tix remind ${enabled ? 'enable' : 'disable'} <rule-id>`);
    process.exit(1);
  }

  const allRules = loadRules();
  const rule = allRules.find(r => r.id === ruleId);

  if (!rule) {
    console.error(`Rule not found: ${ruleId}`);
    process.exit(1);
  }

  rule.enabled = enabled;

  // Save only rules that differ from defaults (custom rules or toggled built-ins)
  saveUserRules(allRules.filter(r => {
    const builtIn = BUILT_IN_RULES.find(b => b.id === r.id);
    return !builtIn || builtIn.enabled !== r.enabled;
  }));

  const icon = enabled ? '✅' : '⏸️';
  console.log(chalk[enabled ? 'green' : 'yellow'](`${icon} Rule "${rule.name}" ${enabled ? 'enabled' : 'disabled'}`));
}

// ─── Remove Rule ──────────────────────────────────────────────────────────────

async function removeRule(ruleId: string) {
  if (!ruleId) {
    console.error('Usage: tix remind remove <rule-id>');
    process.exit(1);
  }

  const allRules = loadRules();
  const rule = allRules.find(r => r.id === ruleId);

  if (!rule) {
    console.error(`Rule not found: ${ruleId}`);
    process.exit(1);
  }

  if (rule.builtIn) {
    console.error('Cannot remove a built-in rule. Use `tix remind disable` instead.');
    process.exit(1);
  }

  const userRules = allRules.filter(r => r.id !== ruleId && !r.builtIn);
  // Also include built-in overrides that aren't the removed one
  const builtInOverrides = allRules.filter(r => r.id !== ruleId && BUILT_IN_RULES.some(b => b.id === r.id));
  saveUserRules([...userRules, ...builtInOverrides]);

  console.log(chalk.red(`🗑️ Removed rule: ${rule.name}`));
}

// ─── History ──────────────────────────────────────────────────────────────────

async function showHistory() {
  const history = getHistory(20);

  if (history.length === 0) {
    console.log('No reminder history yet. Run `tix remind run` to evaluate rules.');
    return;
  }

  console.log(chalk.bold('\n📜 Reminder History (last 20)\n'));

  const table = new Table({
    head: [
      chalk.cyan('Time'),
      chalk.cyan('Rule'),
      chalk.cyan('Entity'),
      chalk.cyan('Title'),
    ],
    colWidths: [22, 20, 14, 40],
    wordWrap: true,
  });

  for (const match of history) {
    table.push([
      new Date(match.timestamp).toLocaleString(),
      match.ruleName,
      match.entityId,
      match.entityTitle,
    ]);
  }

  console.log(table.toString());
}

// ─── Templates ────────────────────────────────────────────────────────────────

function showTemplates() {
  console.log(chalk.bold('\n📦 Built-in Rule Templates\n'));

  for (const rule of BUILT_IN_RULES) {
    console.log(chalk.bold(`  ${rule.name}`) + chalk.dim(` (${rule.id})`));
    console.log(`    ${rule.description}`);
    console.log(`    Target: ${rule.target} | Cooldown: ${rule.cooldown}`);
    console.log(`    Conditions: ${rule.conditions.map(c => `${c.field} ${c.operator} ${JSON.stringify(c.value)}`).join(' AND ')}`);
    console.log(`    Message: ${rule.action.message}`);
    console.log();
  }
}

// ─── Snooze ──────────────────────────────────────────────────────────────────

async function snoozeCommand(reminderId: string, extraArgs: string[]) {
  if (!reminderId) {
    console.error('Usage: tix remind snooze <id> --for <duration>');
    console.log(`  Presets: ${getSnoozePresets().join(', ')}`);
    console.log('  Custom: any duration like 2h, 30m, 3d');
    process.exit(1);
  }

  // Parse --for flag from args
  let duration = '1h'; // default
  const forIdx = extraArgs.indexOf('--for');
  if (forIdx !== -1 && extraArgs[forIdx + 1]) {
    duration = extraArgs[forIdx + 1];
  }

  const match = snoozeReminder(reminderId, duration);
  if (!match) {
    console.error(`Reminder not found: ${reminderId}`);
    console.log('Run `tix remind list` to see available reminders.');
    process.exit(1);
  }

  const until = new Date(match.snoozedUntil!);
  console.log(chalk.blue(`😴 Snoozed "${match.entityTitle}" until ${until.toLocaleString()}`));
  console.log(chalk.dim(`  Rule: ${match.ruleName} | Entity: ${match.entityId}`));
}

// ─── List Reminders ──────────────────────────────────────────────────────────

async function listCommand(args: string[]) {
  const options: { status?: ReminderStatus; type?: 'ticket' | 'pr' | 'backlog'; mine?: boolean } = {};

  // Parse filter flags
  if (args.includes('--active')) options.status = 'active';
  if (args.includes('--triggered')) options.status = 'triggered';
  if (args.includes('--snoozed')) options.status = 'snoozed';
  if (args.includes('--pending')) options.status = 'pending';
  if (args.includes('--mine')) options.mine = true;

  const typeIdx = args.indexOf('--type');
  if (typeIdx !== -1 && args[typeIdx + 1]) {
    const t = args[typeIdx + 1] as 'ticket' | 'pr' | 'backlog';
    if (['ticket', 'pr', 'backlog'].includes(t)) {
      options.type = t;
    }
  }

  const reminders = listReminders(options);

  if (reminders.length === 0) {
    const filterDesc = options.status ? ` (filter: ${options.status})` : '';
    console.log(`No reminders found${filterDesc}. Run \`tix remind run\` to evaluate rules.`);
    return;
  }

  console.log(chalk.bold(`\n⏰ Reminders${options.status ? ` (${options.status})` : ''}\n`));

  const table = new Table({
    head: [
      chalk.cyan('ID'),
      chalk.cyan('Entity'),
      chalk.cyan('Rule'),
      chalk.cyan('Status'),
      chalk.cyan('Triggered'),
    ],
    colWidths: [10, 20, 20, 12, 22],
    wordWrap: true,
  });

  for (const r of reminders) {
    const statusLabel = r.status === 'snoozed'
      ? chalk.blue('snoozed')
      : r.status === 'active'
      ? chalk.green('active')
      : r.status === 'pending'
      ? chalk.magenta('pending')
      : chalk.yellow('triggered');

    table.push([
      r.id,
      r.entityId,
      r.ruleName,
      statusLabel,
      new Date(r.timestamp).toLocaleString(),
    ]);
  }

  console.log(table.toString());
  console.log(chalk.dim(`\n  Filters: --active, --triggered, --snoozed, --pending, --mine, --type <ticket|pr|backlog>`));
  console.log(chalk.dim(`  Use \`tix remind show <id>\` for details, \`tix remind snooze <id> --for 1h\` to snooze`));
}

// ─── Show Reminder ───────────────────────────────────────────────────────────

async function showCommand(reminderId: string) {
  if (!reminderId) {
    console.error('Usage: tix remind show <id>');
    process.exit(1);
  }

  const match = getReminder(reminderId);
  if (!match) {
    console.error(`Reminder not found: ${reminderId}`);
    process.exit(1);
  }

  const status = getReminderStatus(match);
  const rules = loadRules();
  const rule = rules.find(r => r.id === match.ruleId);

  console.log(chalk.bold(`\n📌 Reminder ${match.id}\n`));
  console.log(`  Entity:      ${match.entityId} — ${match.entityTitle}`);
  console.log(`  Rule:        ${match.ruleName} (${match.ruleId})`);
  console.log(`  Status:      ${formatStatus(status)}`);
  console.log(`  Triggered:   ${new Date(match.timestamp).toLocaleString()}`);

  if (match.snoozedUntil) {
    const until = new Date(match.snoozedUntil);
    const isPast = until.getTime() < Date.now();
    console.log(`  Snoozed til: ${until.toLocaleString()}${isPast ? chalk.dim(' (expired)') : ''}`);
  }

  if (match.url) {
    console.log(`  URL:         ${match.url}`);
  }

  console.log(`\n  ${chalk.dim('Message:')}`);
  const consoleMsg = match.message.replace(/\*/g, '').replace(/_/g, '');
  console.log(`  ${consoleMsg}`);

  if (rule) {
    console.log(`\n  ${chalk.dim('Rule details:')}`);
    console.log(`  Target:     ${rule.target}`);
    console.log(`  Cooldown:   ${rule.cooldown}`);
    console.log(`  Conditions: ${rule.conditions.map(c => `${c.field} ${c.operator} ${JSON.stringify(c.value)}`).join(' AND ')}`);
  }

  console.log();
}

// ─── Delete Reminder ─────────────────────────────────────────────────────────

async function deleteCommand(reminderId: string) {
  if (!reminderId) {
    console.error('Usage: tix remind delete <id>');
    process.exit(1);
  }

  const removed = deleteReminder(reminderId);
  if (!removed) {
    console.error(`Reminder not found: ${reminderId}`);
    process.exit(1);
  }

  console.log(chalk.red(`🗑️  Deleted reminder: ${removed.entityId} — ${removed.entityTitle}`));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatStatus(status: ReminderStatus): string {
  switch (status) {
    case 'snoozed': return chalk.blue('😴 snoozed');
    case 'active': return chalk.green('● active');
    case 'triggered': return chalk.yellow('⚡ triggered');
    case 'pending': return chalk.magenta('⏳ pending');
  }
}
