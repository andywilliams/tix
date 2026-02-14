import * as cron from 'node-cron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

interface CronJob {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
  task: string;
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  maxConcurrent: number;
}

interface CronRun {
  id: string;
  jobId: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
  taskId?: string;
  taskTitle?: string;
}

const CRON_CONFIG_DIR = join(homedir(), '.tix-kanban');
const CRON_CONFIG_FILE = join(CRON_CONFIG_DIR, 'cron-config.json');
const RUNS_DIR = join(CRON_CONFIG_DIR, 'runs');

// Ensure directories exist
if (!existsSync(CRON_CONFIG_DIR)) {
  mkdirSync(CRON_CONFIG_DIR, { recursive: true });
}
if (!existsSync(RUNS_DIR)) {
  mkdirSync(RUNS_DIR, { recursive: true });
}

class CronManager {
  private jobs: Map<string, CronJob> = new Map();
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private runningJobs: Map<string, CronRun> = new Map();

  constructor() {
    this.loadJobs();
  }

  private loadJobs() {
    if (existsSync(CRON_CONFIG_FILE)) {
      try {
        const data = readFileSync(CRON_CONFIG_FILE, 'utf-8');
        const jobs = JSON.parse(data) as CronJob[];
        jobs.forEach(job => this.jobs.set(job.id, job));
      } catch (err) {
        console.warn('Failed to load cron config:', err);
      }
    }
  }

  private saveJobs() {
    const jobs = Array.from(this.jobs.values());
    writeFileSync(CRON_CONFIG_FILE, JSON.stringify(jobs, null, 2));
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  private saveRun(run: CronRun) {
    const runFile = join(RUNS_DIR, `${run.id}.json`);
    writeFileSync(runFile, JSON.stringify(run, null, 2));
  }

  async addJob(name: string, expression: string, task: string, options: {
    maxConcurrent?: number;
    enabled?: boolean;
  } = {}): Promise<string> {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }

    const job: CronJob = {
      id: this.generateId(),
      name,
      expression,
      enabled: options.enabled ?? true,
      task,
      runCount: 0,
      maxConcurrent: options.maxConcurrent ?? 1
    };

    this.jobs.set(job.id, job);
    
    if (job.enabled) {
      await this.scheduleJob(job);
    }
    
    this.saveJobs();
    return job.id;
  }

  private async scheduleJob(job: CronJob) {
    const task = cron.schedule(job.expression, async () => {
      await this.executeJob(job);
    }, {
      timezone: 'UTC'
    });

    this.tasks.set(job.id, task);
    
    // Update next run time
    job.nextRun = new Date(Date.now() + 60000).toISOString(); // Approximate
  }

  private async executeJob(job: CronJob) {
    // Check concurrent job limit
    const runningCount = Array.from(this.runningJobs.values())
      .filter(run => run.jobId === job.id && run.status === 'running').length;
    
    if (runningCount >= job.maxConcurrent) {
      console.log(chalk.yellow(`Skipping job ${job.name} - already ${runningCount} running`));
      return;
    }

    const run: CronRun = {
      id: this.generateId(),
      jobId: job.id,
      startTime: new Date().toISOString(),
      status: 'running'
    };

    this.runningJobs.set(run.id, run);
    job.runCount++;
    job.lastRun = run.startTime;
    this.saveJobs();

    console.log(chalk.blue(`Starting cron job: ${job.name}`));

    try {
      // Execute the kanban worker
      const result = await this.executeKanbanWorker();
      
      run.endTime = new Date().toISOString();
      run.status = 'completed';
      run.output = result.stdout;
      run.taskId = result.taskId;
      run.taskTitle = result.taskTitle;

      console.log(chalk.green(`Completed cron job: ${job.name}`));
      
    } catch (error: any) {
      run.endTime = new Date().toISOString();
      run.status = 'failed';
      run.error = error.message;
      
      console.error(chalk.red(`Failed cron job: ${job.name} - ${error.message}`));
    }

    this.runningJobs.delete(run.id);
    this.saveRun(run);
  }

  private async executeKanbanWorker(): Promise<{
    stdout: string;
    taskId?: string;
    taskTitle?: string;
  }> {
    try {
      // Fetch backlog tasks from DWLF Kanban API
      const { stdout: tasksJson } = await execAsync(
        `curl -s "https://api.dwlf.co.uk/v2/kanban/tasks?status=backlog" -H "Authorization: ApiKey dwlf_sk_0a700981551146e5a31e0b5a9b4fe41e2399f7bd"`
      );

      const tasksResponse = JSON.parse(tasksJson);
      const tasks = tasksResponse.tasks || [];

      // Filter for AI-assigned tasks
      const aiTasks = tasks.filter((task: any) => 
        ['jenna', 'Jenna', 'jenna@dwlf.co.uk'].includes(task.assignee)
      );

      if (aiTasks.length === 0) {
        return { stdout: 'No AI-assigned tasks found in backlog' };
      }

      // Sort by priority (highest first)
      aiTasks.sort((a: any, b: any) => b.priority - a.priority);
      const topTask = aiTasks[0];

      // Check if task already has work done
      const { stdout: taskDetailsJson } = await execAsync(
        `curl -s "https://api.dwlf.co.uk/v2/kanban/tasks/${topTask.taskId}" -H "Authorization: ApiKey dwlf_sk_0a700981551146e5a31e0b5a9b4fe41e2399f7bd"`
      );

      const taskDetails = JSON.parse(taskDetailsJson);
      if (taskDetails.links && taskDetails.links.length > 0) {
        return { 
          stdout: `Task "${topTask.title}" already has work done (${taskDetails.links.length} links)`,
          taskId: topTask.taskId,
          taskTitle: topTask.title
        };
      }

      if (taskDetails.comments && taskDetails.comments.length > 0) {
        return { 
          stdout: `Task "${topTask.title}" already has work done (${taskDetails.comments.length} comments)`,
          taskId: topTask.taskId,
          taskTitle: topTask.title
        };
      }

      // Move task to in-progress
      await execAsync(
        `curl -s -X PUT "https://api.dwlf.co.uk/v2/kanban/tasks/${topTask.taskId}" -H "Authorization: ApiKey dwlf_sk_0a700981551146e5a31e0b5a9b4fe41e2399f7bd" -H "Content-Type: application/json" -d '{"status":"in-progress"}'`
      );

      // Create persona prompt for Claude CLI
      const persona = `You are Jenna, a skilled software engineer working on DWLF (dwlf.co.uk), a market analysis platform. You're picking up tasks from the kanban board and implementing them.

Current task: ${topTask.title}
Description: ${topTask.description}

Workspace: /root/clawd
Repos: /root/clawd/repos/ (portfolio-frontend, serverless-portfolio-tracker, dwlf-charting, dwlf-indicators, dwlf-scheduled-jobs, dwlf-cli)

Instructions:
1. Read and understand the task requirements
2. Implement the solution (create branches, make changes, create PRs if needed)
3. Add detailed comments to the kanban task explaining what you did
4. If you create a PR, add a link to the kanban task

Be thorough and follow best practices.`;

      // Execute Claude CLI with the task context
      const { stdout: claudeOutput } = await execAsync(
        `claude --print "${persona.replace(/"/g, '\\"')}"`,
        { 
          timeout: 300000, // 5 minute timeout
          maxBuffer: 1024 * 1024 * 10 // 10MB buffer
        }
      );

      return {
        stdout: claudeOutput,
        taskId: topTask.taskId,
        taskTitle: topTask.title
      };

    } catch (error: any) {
      throw new Error(`Kanban worker failed: ${error.message}`);
    }
  }

  async enableJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    if (!job.enabled) {
      job.enabled = true;
      await this.scheduleJob(job);
      this.saveJobs();
    }
  }

  async disableJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    if (job.enabled) {
      job.enabled = false;
      const task = this.tasks.get(id);
      if (task) {
        task.stop();
        this.tasks.delete(id);
      }
      this.saveJobs();
    }
  }

  async removeJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    await this.disableJob(id);
    this.jobs.delete(id);
    this.saveJobs();
  }

  async triggerJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    await this.executeJob(job);
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  getJobRuns(jobId: string): CronRun[] {
    const runs: CronRun[] = [];
    
    try {
      const files = require('fs').readdirSync(RUNS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const runData = readFileSync(join(RUNS_DIR, file), 'utf-8');
          const run = JSON.parse(runData) as CronRun;
          if (run.jobId === jobId) {
            runs.push(run);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load runs:', err);
    }

    return runs.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  }

  async startAll() {
    for (const job of this.jobs.values()) {
      if (job.enabled && !this.tasks.has(job.id)) {
        await this.scheduleJob(job);
      }
    }
  }

  stopAll() {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }
}

export const cronManager = new CronManager();

// CLI Commands
export async function cronCommand(action: string, ...args: any[]) {
  switch (action) {
    case 'list':
      await listCronJobs();
      break;
    
    case 'add':
      await addCronJob(args[0], args[1], args[2]);
      break;
    
    case 'enable':
      await enableCronJob(args[0]);
      break;
    
    case 'disable':
      await disableCronJob(args[0]);
      break;
    
    case 'remove':
      await removeCronJob(args[0]);
      break;
    
    case 'trigger':
      await triggerCronJob(args[0]);
      break;
    
    case 'runs':
      await showJobRuns(args[0]);
      break;
    
    case 'start':
      await startCronDaemon();
      break;
    
    case 'stop':
      await stopCronDaemon();
      break;
    
    default:
      console.error(`Unknown cron action: ${action}`);
      console.log('Available actions: list, add, enable, disable, remove, trigger, runs, start, stop');
      process.exit(1);
  }
}

async function listCronJobs() {
  const jobs = cronManager.listJobs();
  
  if (jobs.length === 0) {
    console.log('No cron jobs configured.');
    return;
  }

  console.log(chalk.bold('\n📅 Cron Jobs\n'));
  
  for (const job of jobs) {
    const status = job.enabled ? chalk.green('enabled') : chalk.red('disabled');
    const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString() : 'never';
    
    console.log(`${chalk.bold(job.name)} (${job.id})`);
    console.log(`  Expression: ${job.expression}`);
    console.log(`  Status: ${status}`);
    console.log(`  Last run: ${lastRun}`);
    console.log(`  Run count: ${job.runCount}`);
    console.log(`  Max concurrent: ${job.maxConcurrent}`);
    console.log();
  }
}

async function addCronJob(name: string, expression: string, maxConcurrent: string = '1') {
  if (!name || !expression) {
    console.error('Usage: tix cron add <name> <expression> [maxConcurrent]');
    process.exit(1);
  }

  const id = await cronManager.addJob(name, expression, 'kanban-worker', {
    maxConcurrent: parseInt(maxConcurrent, 10)
  });
  
  console.log(chalk.green(`✅ Added cron job: ${name} (${id})`));
}

async function enableCronJob(id: string) {
  if (!id) {
    console.error('Usage: tix cron enable <job-id>');
    process.exit(1);
  }

  await cronManager.enableJob(id);
  console.log(chalk.green(`✅ Enabled cron job: ${id}`));
}

async function disableCronJob(id: string) {
  if (!id) {
    console.error('Usage: tix cron disable <job-id>');
    process.exit(1);
  }

  await cronManager.disableJob(id);
  console.log(chalk.yellow(`⏸️ Disabled cron job: ${id}`));
}

async function removeCronJob(id: string) {
  if (!id) {
    console.error('Usage: tix cron remove <job-id>');
    process.exit(1);
  }

  await cronManager.removeJob(id);
  console.log(chalk.red(`🗑️ Removed cron job: ${id}`));
}

async function triggerCronJob(id: string) {
  if (!id) {
    console.error('Usage: tix cron trigger <job-id>');
    process.exit(1);
  }

  console.log(chalk.blue(`▶️ Triggering cron job: ${id}`));
  await cronManager.triggerJob(id);
}

async function showJobRuns(id: string) {
  if (!id) {
    console.error('Usage: tix cron runs <job-id>');
    process.exit(1);
  }

  const runs = cronManager.getJobRuns(id);
  
  if (runs.length === 0) {
    console.log('No runs found for this job.');
    return;
  }

  console.log(chalk.bold(`\n📊 Job Runs for ${id}\n`));
  
  for (const run of runs.slice(0, 10)) { // Show last 10 runs
    const status = run.status === 'completed' ? chalk.green('✓') :
                   run.status === 'failed' ? chalk.red('✗') :
                   chalk.yellow('⏳');
    
    const duration = run.endTime ? 
      `${Math.round((new Date(run.endTime).getTime() - new Date(run.startTime).getTime()) / 1000)}s` : 
      'running';
    
    console.log(`${status} ${run.startTime} (${duration})`);
    if (run.taskTitle) {
      console.log(`   Task: ${run.taskTitle}`);
    }
    if (run.output && run.output.length < 100) {
      console.log(`   Output: ${run.output.trim()}`);
    }
    if (run.error) {
      console.log(chalk.red(`   Error: ${run.error}`));
    }
    console.log();
  }
}

async function startCronDaemon() {
  console.log(chalk.blue('🚀 Starting cron daemon...'));
  await cronManager.startAll();
  console.log(chalk.green('✅ Cron daemon started'));
}

async function stopCronDaemon() {
  console.log(chalk.yellow('⏹️ Stopping cron daemon...'));
  cronManager.stopAll();
  console.log(chalk.green('✅ Cron daemon stopped'));
}