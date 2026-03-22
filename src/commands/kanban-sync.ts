import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { loadSyncedTickets, loadSubtaskSyncState, saveSubtaskSyncState, SubtaskSyncState } from '../lib/ticket-store';
import { queryMyTickets, createNotionClient, fetchTodoBlocks, NotionTodoBlock } from '../lib/notion';
import type { EqConfig, TicketSummary, TicketDetail } from '../types';

interface KanbanSyncOptions {
  baseUrl?: string;
  dryRun?: boolean;
  verbose?: boolean;
  subtasks?: boolean;
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
  updatedAt?: string;
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
  // Note: we try to fetch even in dry-run so subtask sync can find parent task IDs for preview,
  // but we gracefully continue with an empty list if the server is offline during dry-run.
  let existingTasks: KanbanTask[] = [];
  try {
    const response = execSync(`curl -s "${baseUrl}/tasks"`, { encoding: 'utf-8' });
    const data = JSON.parse(response);
    existingTasks = data.tasks || [];
    if (verbose) {
      console.log(chalk.dim(`Found ${existingTasks.length} existing kanban tasks`));
    }
  } catch (err) {
    if (dryRun) {
      if (verbose) console.log(chalk.dim('Could not reach kanban server — dry-run will continue with empty task list'));
    } else {
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
      // Compare timestamps to determine which source is more recent
      const notionUpdatedAt = ticket.lastUpdated ? new Date(ticket.lastUpdated).getTime() : 0;
      const kanbanUpdatedAt = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const notionIsNewer = notionUpdatedAt > kanbanUpdatedAt;

      // Only update status/priority if Notion is the more recent source
      const statusChanged = existing.status !== kanbanTask.status;
      const priorityChanged = existing.priority !== kanbanTask.priority;
      const descriptionNeedsUpdate = !existing.description?.includes(ticket.url);

      const needsUpdate = (notionIsNewer && (statusChanged || priorityChanged)) || descriptionNeedsUpdate;

      if (needsUpdate && !dryRun) {
        try {
          const updatePayload: Record<string, any> = {
            description: kanbanTask.description,
          };

          // Only sync status and priority from Notion if it was updated more recently
          if (notionIsNewer) {
            if (statusChanged) updatePayload.status = kanbanTask.status;
            if (priorityChanged) updatePayload.priority = kanbanTask.priority;
          }

          execSync(`curl -s -X PUT "${baseUrl}/tasks/${existing.id}" -H "Content-Type: application/json" -d '${JSON.stringify(updatePayload)}'`, { stdio: 'pipe' });
          if (verbose && !notionIsNewer && statusChanged) {
            console.log(chalk.dim(`⏭️  Kept local status for: ${kanbanTask.title} (local is newer)`));
          }
          console.log(chalk.yellow(`📝 Updated: ${kanbanTask.title}`));
          updated++;
        } catch (err) {
          console.error(chalk.red(`Failed to update task ${existing.id}:`), err);
        }
      } else if (needsUpdate && dryRun) {
        // Show dry-run preview
        console.log(chalk.blue(`[DRY RUN] Would update: ${kanbanTask.title}`));
        if (verbose) {
          if (statusChanged && notionIsNewer) console.log(chalk.dim(`  status: ${existing.status} → ${kanbanTask.status}`));
          if (priorityChanged && notionIsNewer) console.log(chalk.dim(`  priority: ${existing.priority} → ${kanbanTask.priority}`));
          if (descriptionNeedsUpdate) console.log(chalk.dim(`  description: would add Notion URL`));
        }
        updated++;
      } else {
        if (verbose) {
          if (statusChanged && !notionIsNewer) {
            console.log(chalk.dim(`⏭️  Kept local status for: ${kanbanTask.title} (local is newer)`));
          } else {
            console.log(chalk.dim(`⏭️  Unchanged: ${kanbanTask.title}`));
          }
        }
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
          
          // Add the newly created task to existingTasks so subtask sync can find it
          existingTasks.push({ ...kanbanTask, id: createdTask.id });

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

  // Warn if --subtasks is used without Notion API key
  if (options.subtasks && !config.notionApiKey) {
    console.warn(chalk.yellow('⚠️  --subtasks requires a Notion API key. Run `tix notion setup` to configure it.'));
  }

  // Subtask sync if --subtasks flag is set
  if (options.subtasks && config.notionApiKey) {
    console.log(chalk.bold.cyan('\n🔗 Syncing Notion subtasks...\n'));

    const syncState = loadSubtaskSyncState();
    const notion = createNotionClient(config);
    let totalSubtasksCreated = 0;
    let totalSubtasksSkipped = 0;

    for (const ticket of tickets) {
      // Find the kanban task ID for this ticket
      const kanbanTask = existingTasks.find(task =>
        (task.title && task.title.includes(ticket.ticketNumber || ticket.id)) ||
        (task.description && task.description.includes(ticket.url))
      );

      if (!kanbanTask?.id) continue;

      const result = await syncSubtasks(
        baseUrl,
        notion,
        kanbanTask.id,
        ticket.id, // Notion page ID
        kanbanTask.priority || 100,
        config.userName,
        syncState,
        verbose,
        dryRun,
        existingTasks
      );

      totalSubtasksCreated += result.created;
      totalSubtasksSkipped += result.skipped;
    }

    // Save sync state
    if (!dryRun) {
      syncState.lastSync = new Date().toISOString();
      saveSubtaskSyncState(syncState);
    }

    console.log(chalk.bold.green(`\n📊 Subtask sync completed:`));
    console.log(chalk.green(`  ✨ Created: ${totalSubtasksCreated} subtasks`));
    console.log(chalk.dim(`  ⏭️  Skipped: ${totalSubtasksSkipped} subtasks`));
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

async function syncSubtasks(
  baseUrl: string,
  notion: any,
  parentTaskId: string,
  notionPageId: string,
  parentPriority: number,
  assignee: string,
  syncState: SubtaskSyncState,
  verbose: boolean,
  dryRun: boolean,
  existingKanbanTasks: KanbanTask[]
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  const todos = await fetchTodoBlocks(notion, notionPageId);

  for (const todo of todos) {
    if (todo.checked) {
      // Skip completed subtasks
      skipped++;
      continue;
    }

    const syncKey = `notion-${notionPageId}-${todo.blockId}`;

    if (syncState.synced[syncKey]) {
      const linkedTaskId = syncState.synced[syncKey];
      // Verify the task still exists in kanban
      const taskStillExists = existingKanbanTasks.some((t: KanbanTask) => t.id === linkedTaskId);
      if (taskStillExists) {
        if (verbose) console.log(chalk.dim(`  ⏭️ Subtask already synced: ${todo.text.substring(0, 50)}`));
        skipped++;
        continue;
      }
      // Task was deleted/doesn't exist — remove stale sync state and re-sync
      if (verbose) console.log(chalk.dim(`  🔄 Re-syncing subtask (linked task no longer exists): ${todo.text.substring(0, 50)}`));
      delete syncState.synced[syncKey];
    }

    if (dryRun) {
      console.log(chalk.blue(`[DRY RUN] Would create subtask: ${todo.text.substring(0, 60)}`));
      created++;
      continue;
    }

    // Create new subtask ticket
    const subtaskData = {
      title: todo.text,
      description: `Synced from Notion checkbox (block ${todo.blockId})`,
      status: 'backlog',
      priority: Math.max(parentPriority - 50, 10), // Slightly lower priority than parent
      assignee,
      parentTaskId,
      tags: ['notion-subtask'],
    };

    try {
      const response = execSync(
        `curl -s -X POST "${baseUrl}/tasks" -H "Content-Type: application/json" -d @-`,
        { encoding: 'utf-8', input: JSON.stringify(subtaskData) }
      );
      const createdTask = JSON.parse(response);

      // Record in sync state
      syncState.synced[syncKey] = createdTask.id;

      console.log(chalk.green(`    ✨ Subtask: ${todo.text.substring(0, 60)}`));
      created++;
    } catch (err) {
      console.error(chalk.red(`    ❌ Failed to create subtask: ${todo.text.substring(0, 50)}`));
    }
  }

  return { created, skipped };
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