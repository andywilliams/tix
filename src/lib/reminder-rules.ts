import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadSyncedTickets, loadCachedPRs } from './ticket-store';
import { loadConfig } from './config';
import type { TicketSummary, CachedPR } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RuleCondition {
  field: string;          // e.g. 'status', 'priority', 'age', 'pr.reviews', 'pr.unresolvedComments'
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'not_in';
  value: string | number | string[];
}

export interface RuleAction {
  type: 'slack' | 'console';
  message: string;        // Supports {id}, {title}, {status}, {age}, {priority}, {url} placeholders
}

export interface ReminderRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  target: 'ticket' | 'pr' | 'backlog';  // What entity the rule evaluates
  conditions: RuleCondition[];           // ALL conditions must match (AND logic)
  action: RuleAction;
  cooldown: string;        // e.g. '24h', '12h', '1h'
  builtIn?: boolean;       // True for shipped templates
}

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  entityId: string;       // Ticket number or PR number
  entityTitle: string;
  message: string;
  url?: string;
  timestamp: string;
}

interface CooldownState {
  [key: string]: string;  // ruleId:entityId -> last fired ISO timestamp
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const TIX_DIR = path.join(os.homedir(), '.tix');
const RULES_FILE = path.join(TIX_DIR, 'reminder-rules.json');
const COOLDOWN_FILE = path.join(TIX_DIR, 'reminder-cooldowns.json');
const HISTORY_FILE = path.join(TIX_DIR, 'reminder-history.json');

function ensureDir() {
  if (!fs.existsSync(TIX_DIR)) {
    fs.mkdirSync(TIX_DIR, { recursive: true });
  }
}

// ─── Built-in Rule Templates ──────────────────────────────────────────────────

export const BUILT_IN_RULES: ReminderRule[] = [
  {
    id: 'builtin-review-stale',
    name: 'Stale Review',
    description: 'Alert if any ticket stays in review for more than 5 days',
    enabled: true,
    target: 'ticket',
    conditions: [
      { field: 'status', operator: 'in', value: ['review', 'in review', 'code review'] },
      { field: 'age', operator: '>', value: '5d' },
    ],
    action: {
      type: 'slack',
      message: '🔍 *{ticketNumber}* has been in review for {age} — _{title}_\n{url}',
    },
    cooldown: '24h',
    builtIn: true,
  },
  {
    id: 'builtin-pr-no-activity',
    name: 'Stale PR',
    description: 'Remind about any PR with no activity for 3 days',
    enabled: true,
    target: 'pr',
    conditions: [
      { field: 'age', operator: '>', value: '3d' },
      { field: 'reviewDecision', operator: '!=', value: 'APPROVED' },
    ],
    action: {
      type: 'slack',
      message: '⏳ PR #{number} has had no activity for {age} — _{title}_\n{url}',
    },
    cooldown: '24h',
    builtIn: true,
  },
  {
    id: 'builtin-backlog-overflow',
    name: 'Backlog Overflow',
    description: 'Notify when backlog grows beyond 10 items',
    enabled: true,
    target: 'backlog',
    conditions: [
      { field: 'count', operator: '>', value: 10 },
      { field: 'status', operator: 'in', value: ['backlog', 'not started', 'todo'] },
    ],
    action: {
      type: 'slack',
      message: '📋 Backlog alert: {count} items in backlog (threshold: 10)',
    },
    cooldown: '24h',
    builtIn: true,
  },
  {
    id: 'builtin-blocked-ticket',
    name: 'Blocked Ticket',
    description: 'Alert if any ticket has been blocked for more than 2 days',
    enabled: true,
    target: 'ticket',
    conditions: [
      { field: 'status', operator: 'in', value: ['blocked', 'on hold'] },
      { field: 'age', operator: '>', value: '2d' },
    ],
    action: {
      type: 'slack',
      message: '🚫 *{ticketNumber}* has been blocked for {age} — _{title}_\n{url}',
    },
    cooldown: '24h',
    builtIn: true,
  },
  {
    id: 'builtin-pr-unresolved',
    name: 'Unresolved PR Comments',
    description: 'Remind about PRs with unresolved review comments',
    enabled: true,
    target: 'pr',
    conditions: [
      { field: 'unresolvedComments', operator: '>', value: 0 },
      { field: 'age', operator: '>', value: '1d' },
    ],
    action: {
      type: 'slack',
      message: '💬 PR #{number} has {unresolvedComments} unresolved comments — _{title}_\n{url}',
    },
    cooldown: '12h',
    builtIn: true,
  },
];

// ─── Rule Storage ─────────────────────────────────────────────────────────────

export function loadRules(): ReminderRule[] {
  ensureDir();
  let userRules: ReminderRule[] = [];

  if (fs.existsSync(RULES_FILE)) {
    try {
      userRules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    } catch {
      userRules = [];
    }
  }

  // Merge built-in rules with user rules (user rules override built-in by ID)
  const userRuleIds = new Set(userRules.map(r => r.id));
  const merged = [
    ...BUILT_IN_RULES.filter(r => !userRuleIds.has(r.id)),
    ...userRules,
  ];

  return merged;
}

export function saveUserRules(rules: ReminderRule[]): void {
  ensureDir();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2) + '\n');
}

function loadCooldowns(): CooldownState {
  if (fs.existsSync(COOLDOWN_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCooldowns(state: CooldownState): void {
  ensureDir();
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(state, null, 2));
}

function loadHistory(): RuleMatch[] {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveHistory(matches: RuleMatch[]): void {
  ensureDir();
  // Keep last 200 entries
  const trimmed = matches.slice(-200);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

// ─── Duration Parsing ─────────────────────────────────────────────────────────

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(h|d|m)$/);
  if (!match) {
    console.error(chalk.yellow(`⚠️ Invalid duration "${duration}", defaulting to 24h. Use format: <number><m|h|d> (e.g. 1h, 2d, 30m)`));
    return 24 * 60 * 60 * 1000;
  }
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function formatAge(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

// ─── Condition Evaluation ─────────────────────────────────────────────────────

function getAge(lastUpdated: string): number {
  return Date.now() - new Date(lastUpdated).getTime();
}

function compareDuration(actualMs: number, operator: string, thresholdStr: string | number | string[]): boolean {
  const threshold = typeof thresholdStr === 'string' ? parseDuration(thresholdStr)
    : typeof thresholdStr === 'number' ? thresholdStr
    : parseDuration(String(thresholdStr));
  switch (operator) {
    case '>': return actualMs > threshold;
    case '<': return actualMs < threshold;
    case '>=': return actualMs >= threshold;
    case '<=': return actualMs <= threshold;
    default: return false;
  }
}

function compareValue(actual: string | number, operator: string, expected: string | number | string[]): boolean {
  switch (operator) {
    case '=':
      return String(actual).toLowerCase() === String(expected).toLowerCase();
    case '!=':
      return String(actual).toLowerCase() !== String(expected).toLowerCase();
    case '>':
      return Number(actual) > Number(expected);
    case '<':
      return Number(actual) < Number(expected);
    case '>=':
      return Number(actual) >= Number(expected);
    case '<=':
      return Number(actual) <= Number(expected);
    case 'in':
      if (Array.isArray(expected)) {
        return expected.some(v => String(actual).toLowerCase() === v.toLowerCase());
      }
      return false;
    case 'not_in':
      if (Array.isArray(expected)) {
        return !expected.some(v => String(actual).toLowerCase() === v.toLowerCase());
      }
      return true;
    default:
      return false;
  }
}

function evaluateTicketCondition(condition: RuleCondition, ticket: TicketSummary): boolean {
  const { field, operator, value } = condition;

  if (field === 'age') {
    const ageMs = getAge(ticket.lastUpdated);
    return compareDuration(ageMs, operator, value);
  }

  const fieldMap: Record<string, string | number> = {
    status: ticket.status,
    priority: ticket.priority,
    ticketNumber: ticket.ticketNumber,
    title: ticket.title,
  };

  const actual = fieldMap[field];
  if (actual === undefined) return false;
  return compareValue(actual, operator, value);
}

function evaluatePRCondition(condition: RuleCondition, pr: CachedPR): boolean {
  const { field, operator, value } = condition;

  if (field === 'age') {
    const ageMs = getAge(pr.updatedAt);
    return compareDuration(ageMs, operator, value);
  }

  const fieldMap: Record<string, string | number> = {
    reviewDecision: pr.reviewDecision,
    unresolvedComments: pr.unresolvedComments,
    title: pr.title,
    repo: pr.repo,
    number: pr.number,
    ticketId: pr.ticketId,
  };

  const actual = fieldMap[field];
  if (actual === undefined) return false;
  return compareValue(actual, operator, value);
}

// ─── Template Interpolation ───────────────────────────────────────────────────

function interpolateTicket(template: string, ticket: TicketSummary): string {
  const ageMs = getAge(ticket.lastUpdated);
  return template
    .replace(/\{id\}/g, ticket.id)
    .replace(/\{ticketNumber\}/g, ticket.ticketNumber)
    .replace(/\{title\}/g, ticket.title)
    .replace(/\{status\}/g, ticket.status)
    .replace(/\{priority\}/g, ticket.priority)
    .replace(/\{age\}/g, formatAge(ageMs))
    .replace(/\{url\}/g, ticket.url || '');
}

function interpolatePR(template: string, pr: CachedPR): string {
  const ageMs = getAge(pr.updatedAt);
  return template
    .replace(/\{number\}/g, String(pr.number))
    .replace(/\{title\}/g, pr.title)
    .replace(/\{repo\}/g, pr.repo)
    .replace(/\{url\}/g, pr.url)
    .replace(/\{age\}/g, formatAge(ageMs))
    .replace(/\{ticketId\}/g, pr.ticketId || '')
    .replace(/\{reviewDecision\}/g, pr.reviewDecision || '')
    .replace(/\{unresolvedComments\}/g, String(pr.unresolvedComments));
}

// ─── Cooldown Check ───────────────────────────────────────────────────────────

function isCoolingDown(ruleId: string, entityId: string, cooldown: string, state: CooldownState): boolean {
  const key = `${ruleId}:${entityId}`;
  const lastFired = state[key];
  if (!lastFired) return false;

  const cooldownMs = parseDuration(cooldown);
  const elapsed = Date.now() - new Date(lastFired).getTime();
  return elapsed < cooldownMs;
}

function markFired(ruleId: string, entityId: string, state: CooldownState): void {
  state[`${ruleId}:${entityId}`] = new Date().toISOString();
}

// ─── Core Engine ──────────────────────────────────────────────────────────────

export function evaluateRules(options: { dryRun?: boolean } = {}): RuleMatch[] {
  const rules = loadRules().filter(r => r.enabled);
  const tickets = loadSyncedTickets();
  const prs = loadCachedPRs();
  const cooldowns = loadCooldowns();
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    try {
      if (rule.target === 'ticket') {
        for (const ticket of tickets) {
          const allMatch = rule.conditions.every(c => evaluateTicketCondition(c, ticket));
          if (!allMatch) continue;

          const entityId = ticket.ticketNumber || ticket.id;
          if (isCoolingDown(rule.id, entityId, rule.cooldown, cooldowns)) continue;

          const message = interpolateTicket(rule.action.message, ticket);
          matches.push({
            ruleId: rule.id,
            ruleName: rule.name,
            entityId,
            entityTitle: ticket.title,
            message,
            url: ticket.url,
            timestamp: new Date().toISOString(),
          });

          if (!options.dryRun) {
            markFired(rule.id, entityId, cooldowns);
          }
        }
      }

      if (rule.target === 'pr') {
        for (const pr of prs) {
          const allMatch = rule.conditions.every(c => evaluatePRCondition(c, pr));
          if (!allMatch) continue;

          const entityId = String(pr.number);
          if (isCoolingDown(rule.id, entityId, rule.cooldown, cooldowns)) continue;

          const message = interpolatePR(rule.action.message, pr);
          matches.push({
            ruleId: rule.id,
            ruleName: rule.name,
            entityId,
            entityTitle: pr.title,
            message,
            url: pr.url,
            timestamp: new Date().toISOString(),
          });

          if (!options.dryRun) {
            markFired(rule.id, entityId, cooldowns);
          }
        }
      }

      if (rule.target === 'backlog') {
        // Backlog rules evaluate aggregate counts
        const statusCondition = rule.conditions.find(c => c.field === 'status');
        const countCondition = rule.conditions.find(c => c.field === 'count');

        if (statusCondition && countCondition) {
          const statusValues = Array.isArray(statusCondition.value)
            ? statusCondition.value
            : [String(statusCondition.value)];

          const matchingTickets = tickets.filter(t =>
            statusValues.some(v => t.status.toLowerCase() === v.toLowerCase())
          );

          const count = matchingTickets.length;
          const countMatches = compareValue(count, countCondition.operator, countCondition.value);

          if (countMatches) {
            const entityId = 'backlog';
            if (isCoolingDown(rule.id, entityId, rule.cooldown, cooldowns)) continue;

            const message = rule.action.message
              .replace(/\{count\}/g, String(count));

            matches.push({
              ruleId: rule.id,
              ruleName: rule.name,
              entityId,
              entityTitle: `${count} backlog items`,
              message,
              timestamp: new Date().toISOString(),
            });

            if (!options.dryRun) {
              markFired(rule.id, entityId, cooldowns);
            }
          }
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`⚠️ Error evaluating rule "${rule.name}" (${rule.id}): ${err.message}`));
    }
  }

  if (!options.dryRun) {
    saveCooldowns(cooldowns);
    if (matches.length > 0) {
      const history = loadHistory();
      history.push(...matches);
      saveHistory(history);
    }
  }

  return matches;
}

// ─── Slack Notification ───────────────────────────────────────────────────────

export async function sendReminderToSlack(webhookUrl: string, matches: RuleMatch[]): Promise<void> {
  const { execFileSync } = await import('child_process');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `⏰ Tix Reminders (${matches.length})` },
    },
  ];

  for (const match of matches) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: match.message },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `_Triggered at ${new Date().toLocaleString()}_` },
    ],
  });

  const payload = JSON.stringify({ blocks });

  try {
    const result = execFileSync('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-type: application/json',
      '--data', payload,
      webhookUrl,
    ], { encoding: 'utf-8', stdio: 'pipe', timeout: 15000 });

    if (result.trim() === 'ok') {
      console.log(chalk.green(`✅ Sent ${matches.length} reminder(s) to Slack`));
    } else {
      console.log(chalk.yellow(`⚠️ Slack response: ${result}`));
    }
  } catch (err: any) {
    console.error(chalk.red(`Failed to post reminders to Slack: ${err.message}`));
  }
}

// ─── History ──────────────────────────────────────────────────────────────────

export function getHistory(limit: number = 20): RuleMatch[] {
  return loadHistory().slice(-limit).reverse();
}

export function clearCooldowns(): void {
  saveCooldowns({});
}
