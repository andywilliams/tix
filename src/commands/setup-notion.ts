import inquirer from 'inquirer';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { extractNotionId } from '../lib/config';

export interface NotionKanbanConfig {
  apiKey: string;
  databaseId: string;
  userName: string;
  statusMappings: {
    [notionStatus: string]: 'backlog' | 'in-progress' | 'review' | 'done';
  };
  syncEnabled: boolean;
}

const NOTION_CONFIG_FILE = path.join(os.homedir(), '.tix-kanban', 'notion-config.json');

function getDefaultStatusMappings(): { [notionStatus: string]: 'backlog' | 'in-progress' | 'review' | 'done' } {
  return {
    'To Do': 'backlog',
    'Not started': 'backlog',
    'Backlog': 'backlog',
    'New': 'backlog',
    'In Progress': 'in-progress',
    'Doing': 'in-progress',
    'Active': 'in-progress',
    'Working on it': 'in-progress',
    'Review': 'review',
    'Testing': 'review',
    'Pending': 'review',
    'Ready for review': 'review',
    'Done': 'done',
    'Complete': 'done',
    'Completed': 'done',
    'Shipped': 'done',
    'Closed': 'done',
  };
}

async function configExists(): Promise<boolean> {
  try {
    await fs.access(NOTION_CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

async function loadExistingConfig(): Promise<NotionKanbanConfig | null> {
  try {
    const configData = await fs.readFile(NOTION_CONFIG_FILE, 'utf-8');
    return JSON.parse(configData);
  } catch {
    return null;
  }
}

async function saveConfig(config: NotionKanbanConfig): Promise<void> {
  const configDir = path.dirname(NOTION_CONFIG_FILE);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(NOTION_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function setupNotionCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n🔗 tix setup notion\n'));
  console.log('Configure Notion sync for tix-kanban.\n');

  if (await configExists()) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Notion kanban config already exists. Overwrite?',
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.yellow('Setup cancelled.'));
      return;
    }
  }

  console.log(chalk.dim('This will configure Notion sync for your tix-kanban board.'));
  console.log(chalk.dim('You need a Notion integration with access to your ticket database.\n'));

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'notionApiKey',
      message: 'Notion API key (integration token):',
      mask: '*',
      validate: (input: string) =>
        input.startsWith('secret_') || input.startsWith('ntn_')
          ? true
          : 'Notion API keys start with "secret_" or "ntn_"',
    },
    {
      type: 'input',
      name: 'notionDatabaseId',
      message: 'Notion database ID (or full URL):',
      validate: (input: string) => {
        try {
          extractNotionId(input);
          return true;
        } catch {
          return 'Could not extract a valid Notion ID. Provide a 32-char hex ID or Notion URL.';
        }
      },
    },
    {
      type: 'input',
      name: 'userName',
      message: 'Your name (as it appears in Notion "Assigned to"):',
      validate: (input: string) =>
        input.trim().length > 0 ? true : 'Name is required',
    },
    {
      type: 'confirm',
      name: 'enableSync',
      message: 'Enable automatic sync?',
      default: true,
    },
  ]);

  // Ask about custom status mappings
  console.log(chalk.dim('\n📊 Status Mappings'));
  console.log(chalk.dim('Map your Notion statuses to kanban columns.\n'));
  
  const { useDefaults } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useDefaults',
      message: 'Use default status mappings? (recommended)',
      default: true,
    },
  ]);

  let statusMappings = getDefaultStatusMappings();

  if (!useDefaults) {
    console.log(chalk.dim('\nCustom status mapping (press Enter for each to use defaults):'));
    
    const customMappings: any = {};
    const commonStatuses = [
      'To Do', 'In Progress', 'Review', 'Done',
      'Not started', 'Doing', 'Testing', 'Complete'
    ];

    for (const status of commonStatuses) {
      const { mapping } = await inquirer.prompt([
        {
          type: 'list',
          name: 'mapping',
          message: `Map "${status}" to:`,
          choices: [
            { name: 'Backlog', value: 'backlog' },
            { name: 'In Progress', value: 'in-progress' },
            { name: 'Review', value: 'review' },
            { name: 'Done', value: 'done' },
            { name: 'Skip this status', value: null },
          ],
          default: (statusMappings as any)[status] ? 
            Object.entries({
              'backlog': 'Backlog',
              'in-progress': 'In Progress', 
              'review': 'Review',
              'done': 'Done'
            }).find(([k]) => k === (statusMappings as any)[status])?.[1] : 'Skip this status'
        },
      ]);
      
      if (mapping) {
        customMappings[status] = mapping;
      }
    }

    statusMappings = { ...statusMappings, ...customMappings } as { [notionStatus: string]: 'backlog' | 'in-progress' | 'review' | 'done' };
  }

  const config: NotionKanbanConfig = {
    apiKey: answers.notionApiKey.trim(),
    databaseId: extractNotionId(answers.notionDatabaseId),
    userName: answers.userName.trim(),
    statusMappings,
    syncEnabled: answers.enableSync,
  };

  await saveConfig(config);

  console.log(chalk.green(`\n✅ Notion kanban config saved to ${NOTION_CONFIG_FILE}`));
  
  if (config.syncEnabled) {
    console.log(chalk.dim('\n✨ Sync is enabled! Your kanban board will now pull tasks from Notion.'));
    console.log(chalk.dim('\nTo manually sync: POST to http://localhost:3001/api/notion/sync'));
    console.log(chalk.dim('Or use the sync button in the tix-kanban UI.'));
  } else {
    console.log(chalk.dim('\n⏸️  Sync is disabled. Enable it later in the kanban UI settings.'));
  }

  console.log(chalk.dim('\nStatus mappings:'));
  for (const [notion, kanban] of Object.entries(config.statusMappings)) {
    console.log(chalk.dim(`  "${notion}" → ${kanban}`));
  }

  console.log(chalk.dim('\n🚀 Start tix-kanban with: cd tix-kanban && npm run dev'));
  console.log(chalk.dim('Then visit: http://localhost:3000\n'));
}