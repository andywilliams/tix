import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { loadSyncedTickets } from '../lib/ticket-store';
import { queryMyTickets, createNotionClient } from '../lib/notion';
import type { EqConfig, TicketSummary, TicketDetail } from '../types';

interface KanbanSyncOptions {
  baseUrl?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

interface KanbanTask {
  id?: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignee?: string;
  repo?: string;
  tags: string[];
}

const STATUS_MAPPING: Record<string, string> = {
  // Notion status -> tix-kanban status
  'Not started': 'backlog',
  'To Do': 'backlog',
  'Todo': 'backlog',
  'Backlog': 'backlog',
  'Ready': 'backlog',
  'In Progress': 'in-progress',
  'In progress': 'in-progress',
  'Working': 'in-progress',
  'Doing': 'in-progress',
  'Active': 'in-progress',
  'Review': 'review',
  'In Review': 'review',
  'Code Review': 'review',
  'Testing': 'review',
  'QA': 'review',
  'Done': 'done',
  'Complete': 'done',
  'Completed': 'done',
  'Shipped': 'done',
  'Released': 'done',
  'Closed': 'done',
};

const PRIORITY_MAPPING: Record<string, number> = {
  // Notion priority -> numeric priority (higher = more important)
  'High': 200,
  'Medium': 100,
  'Low': 50,
  'Critical': 300,
  'Urgent': 250,
  '': 100, // default for empty priority
};

export async function kanbanSyncCommand(options: KanbanSyncOptions = {}): Promise<void> {
  const config = loadConfig();
  const baseUrl = options.baseUrl || 'http://localhost:3001/api';
  const verbose = !!options.verbose;
  const dryRun = !!options.dryRun;

  console.log(chalk.bold.cyan('\n🔄 tix kanban-sync — Sync Notion tickets to tix-kanban\n'));

  if (!config.userName) {
    console.error(chalk.red('No userName in config. Run `tix setup` first.'));
    process.exit(1);
  }

  // Step 1: Check if tix-kanban is running
  if (!dryRun) {
    try {
      execSync(`curl -s "${baseUrl}/tasks" > /dev/null`, { stdio: 'pipe' });
    } catch {
      console.error(chalk.red(`tix-kanban not accessible at ${baseUrl}`));
      console.error(chalk.dim('Make sure tix-kanban is running: cd /path/to/tix-kanban && npm start'));
      process.exit(1);
    }
  }

  // Step 2: Get tickets from tix (use existing sync mechanism)
  let tickets: TicketSummary[] = [];
  
  if (config.notionApiKey) {
    console.log(chalk.dim('Fetching tickets from Notion API...'));
    const client = createNotionClient(config);
    
    // Use tix's existing fetchTicketsByIds to get all tickets for the user
    const allTickets = await fetchAllUserTickets(config);
    tickets = allTickets;
  } else {
    console.log(chalk.dim('Using cached tickets from `tix sync`...'));
    tickets = loadSyncedTickets();
    if (tickets.length === 0) {
      console.error(chalk.red('No cached tickets found. Run `tix sync` first.'));
      process.exit(1);
    }
  }

  console.log(chalk.green(`✅ Found ${tickets.length} tickets`));
  if (verbose) {
    console.log(chalk.dim('Tickets: ' + tickets.map(t => `${t.ticketNumber || t.id} (${t.status})`).join(', ')));
  }

  // Step 3: Get existing kanban tasks to avoid duplicates
  let existingTasks: KanbanTask[] = [];
  if (!dryRun) {
    try {
      const response = execSync(`curl -s "${baseUrl}/tasks"`, { encoding: 'utf-8' });
      const data = JSON.parse(response);
      existingTasks = data.tasks || [];
      if (verbose) {
        console.log(chalk.dim(`Found ${existingTasks.length} existing kanban tasks`));
      }
    } catch (err) {
      console.error(chalk.red('Failed to fetch existing kanban tasks:'), err);
      process.exit(1);
    }
  }

  // Step 4: Process each ticket
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const ticket of tickets) {
    const ticketId = ticket.ticketNumber || ticket.id;
    const existing = existingTasks.find(task => 
      (task.title && task.title.includes(ticketId)) || 
      (task.description && task.description.includes(ticket.url)) ||
      (task.repo && task.repo === extractRepoFromLinks(ticket.githubLinks))
    );

    // Map Notion data to tix-kanban format
    const kanbanTask: KanbanTask = {
      title: ticketId ? `${ticketId} ${ticket.title}` : ticket.title,
      description: buildTaskDescription(ticket),
      status: STATUS_MAPPING[ticket.status] || 'backlog',
      priority: PRIORITY_MAPPING[ticket.priority] || 100,
      assignee: config.userName,
      repo: extractRepoFromLinks(ticket.githubLinks),
      tags: buildTaskTags(ticket),
    };

    if (existing) {
      // Update existing task if status or priority changed
      const needsUpdate = 
        existing.status !== kanbanTask.status ||
        existing.priority !== kanbanTask.priority ||
        !existing.description?.includes(ticket.url);

      if (needsUpdate && !dryRun) {
        try {
          const updatePayload = {
            status: kanbanTask.status,
            priority: kanbanTask.priority,
            description: kanbanTask.description,
          };
          
          execSync(`curl -s -X PUT "${baseUrl}/tasks/${existing.id}" -H "Content-Type: application/json" -d '${JSON.stringify(updatePayload)}'`, { stdio: 'pipe' });
          console.log(chalk.yellow(`📝 Updated: ${kanbanTask.title}`));
          updated++;
        } catch (err) {
          console.error(chalk.red(`Failed to update task ${existing.id}:`), err);
        }
      } else {
        if (verbose) console.log(chalk.dim(`⏭️  Unchanged: ${kanbanTask.title}`));
        skipped++;
      }

      // Always sync links for existing tasks (regardless of needsUpdate)
      if (!dryRun) {
        const existingLinks = fetchTaskLinks(baseUrl, existing.id!);
        syncTaskLinks(baseUrl, existing.id!, ticket, ticketId, existingLinks, verbose);
      }
    } else {
      // Create new task
      if (!dryRun) {
        try {
          const createResponse = execSync(`curl -s -X POST "${baseUrl}/tasks" -H "Content-Type: application/json" -d '${JSON.stringify(kanbanTask)}'`, { encoding: 'utf-8' });
          const createdTask = JSON.parse(createResponse);
          
          // Add links (GitHub PRs + Notion)
          syncTaskLinks(baseUrl, createdTask.id, ticket, ticketId, [], verbose);
          
          console.log(chalk.green(`✨ Created: ${kanbanTask.title}`));
          created++;
        } catch (err) {
          console.error(chalk.red(`Failed to create task:`), err);
        }
      } else {
        console.log(chalk.blue(`[DRY RUN] Would create: ${kanbanTask.title}`));
        created++;
      }
    }
  }

  // Summary
  console.log(chalk.bold.green(`\n📊 Sync completed:`));
  console.log(chalk.green(`  ✨ Created: ${created} tasks`));
  console.log(chalk.yellow(`  📝 Updated: ${updated} tasks`));
  console.log(chalk.dim(`  ⏭️  Skipped: ${skipped} tasks`));
  
  if (dryRun) {
    console.log(chalk.dim('\n(This was a dry run - no changes were made)'));
  } else {
    console.log(chalk.dim(`\nView your kanban board: http://localhost:3001`));
  }
}

function buildTaskDescription(ticket: TicketSummary): string {
  const parts = [
    `**Notion:** ${ticket.url}`,
    `**Status:** ${ticket.status}`,
    `**Priority:** ${ticket.priority}`,
    `**Last Updated:** ${ticket.lastUpdated}`,
  ];

  if (ticket.githubLinks.length > 0) {
    parts.push(`**GitHub PRs:** ${ticket.githubLinks.length}`);
  }

  return parts.join('\n');
}

function buildTaskTags(ticket: TicketSummary): string[] {
  const tags = ['notion-sync'];
  
  if (ticket.ticketNumber) {
    tags.push(ticket.ticketNumber.toLowerCase());
  }
  
  if (ticket.priority) {
    tags.push(`priority-${ticket.priority.toLowerCase()}`);
  }

  return tags;
}

function extractRepoFromLinks(links: string[]): string | undefined {
  for (const link of links) {
    const match = link.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function extractPRNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? match[1] : 'Unknown';
}

function fetchTaskLinks(baseUrl: string, taskId: string): string[] {
  try {
    const response = execSync(`curl -s "${baseUrl}/tasks/${taskId}"`, { encoding: 'utf-8' });
    const task = JSON.parse(response);
    return (task.links || []).map((l: any) => l.url);
  } catch {
    return [];
  }
}

function syncTaskLinks(baseUrl: string, taskId: string, ticket: TicketSummary, ticketId: string, existingUrls: string[], verbose: boolean): void {
  try {
    // Add Notion link if missing
    if (!existingUrls.includes(ticket.url)) {
      const notionLink = { url: ticket.url, title: ticketId || 'Notion ticket', type: 'notion' };
      execSync(`curl -s -X POST "${baseUrl}/tasks/${taskId}/links" -H "Content-Type: application/json" -d '${JSON.stringify(notionLink)}'`, { stdio: 'pipe' });
    }

    // Add GitHub PR links if missing
    for (const prUrl of ticket.githubLinks) {
      if (!existingUrls.includes(prUrl)) {
        const prNumber = extractPRNumber(prUrl);
        const prLink = { url: prUrl, title: `PR #${prNumber}`, type: 'pr' };
        execSync(`curl -s -X POST "${baseUrl}/tasks/${taskId}/links" -H "Content-Type: application/json" -d '${JSON.stringify(prLink)}'`, { stdio: 'pipe' });
      }
    }
  } catch (err) {
    if (verbose) console.error(chalk.dim(`Failed to sync links for ${taskId}`));
  }
}

// Fetch all user tickets using tix's existing Notion integration
async function fetchAllUserTickets(config: EqConfig): Promise<TicketSummary[]> {
  try {
    const client = createNotionClient(config);
    return await queryMyTickets(client, config);
  } catch (err: any) {
    console.log(chalk.dim(`Failed to fetch from Notion API (${err.message}) - using cached tickets`));
    return loadSyncedTickets();
  }
}