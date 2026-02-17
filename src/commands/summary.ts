import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../lib/config';
import { getLogEntriesForDateRange } from './log';
import { execSync } from 'child_process';

interface WeeklySummary {
  weekOf: string;
  startDate: string;
  endDate: string;
  author: string;
  generatedAt: string;
  standups: StandupSummary[];
  commits: CommitSummary[];
  logEntries: LogEntrySummary[];
  prActivity: PRSummary[];
  summary: string;
  keyAccomplishments: string[];
  nextWeekFocus: string[];
}

interface StandupSummary {
  date: string;
  yesterdayCount: number;
  todayCount: number;
  blockerCount: number;
  hasActivity: boolean;
}

interface CommitSummary {
  repo: string;
  commitCount: number;
  messages: string[];
}

interface LogEntrySummary {
  date: string;
  entries: string[];
}

interface PRSummary {
  repo: string;
  opened: number;
  merged: number;
  closed: number;
}

const SUMMARY_DIR = path.join(os.homedir(), '.tix', 'summaries');
const STANDUP_DIR = path.join(os.homedir(), '.tix', 'standups');

/**
 * Ensure summary directory exists
 */
function ensureSummaryDir(): void {
  if (!fs.existsSync(SUMMARY_DIR)) {
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });
  }
}

/**
 * Get the Monday of the week for a given date
 */
function getWeekStartDate(date: Date): string {
  const monday = new Date(date);
  const dayOfWeek = monday.getDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Handle Sunday (0) as 6 days back
  monday.setDate(monday.getDate() - daysToSubtract);
  return monday.toISOString().split('T')[0];
}

/**
 * Get date range for a week
 */
function getWeekDateRange(weekStart: string): { start: string; end: string } {
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6); // Sunday
  
  return {
    start: weekStart,
    end: end.toISOString().split('T')[0]
  };
}

/**
 * Load standup entries for a date range
 */
function loadStandupsForWeek(startDate: string, endDate: string): StandupSummary[] {
  if (!fs.existsSync(STANDUP_DIR)) return [];
  
  const summaries: StandupSummary[] = [];
  const files = fs.readdirSync(STANDUP_DIR).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const date = file.replace('.json', '');
    if (date >= startDate && date <= endDate) {
      try {
        const filepath = path.join(STANDUP_DIR, file);
        const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        
        summaries.push({
          date,
          yesterdayCount: content.yesterday?.length || 0,
          todayCount: content.today?.length || 0,
          blockerCount: content.blockers?.length || 0,
          hasActivity: (content.commits?.length || 0) + (content.prs?.length || 0) + (content.issues?.length || 0) > 0
        });
      } catch (err) {
        console.warn(chalk.yellow(`Warning: Could not read standup ${file}: ${err}`));
      }
    }
  }
  
  return summaries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get git commit summary for the week
 */
function getCommitSummaryForWeek(config: any, startDate: string, endDate: string): CommitSummary[] {
  const repoSummaries: { [repo: string]: CommitSummary } = {};
  
  // Look for repos in common locations
  const searchPaths = [
    path.join(os.homedir(), 'repos'),
    path.join(os.homedir(), 'code'),
    path.join(os.homedir(), 'projects'),
    '/root/clawd/repos',
    process.cwd()
  ];

  const repos = [
    'em-boxes-events',
    'em-transactions-api', 
    'em-contracts',
    'tix',
    'tix-kanban',
    'serverless-portfolio-tracker',
    'portfolio-frontend',
    'dwlf-indicators',
    'dwlf-charting',
    'dwlf-scheduled-jobs'
  ];

  for (const repoName of repos) {
    let found = false;

    for (const searchPath of searchPaths) {
      const repoPath = path.join(searchPath, repoName);
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        try {
          const since = `${startDate}T00:00:00`;
          const until = `${endDate}T23:59:59`;
          const cmd = `git log --since="${since}" --until="${until}" --pretty=format:"%s" --no-merges --author="${config.userName}"`;
          
          const output = execSync(cmd, { 
            cwd: repoPath, 
            encoding: 'utf-8',
            stdio: 'pipe'
          }).trim();

          if (output) {
            const messages = output.split('\n').map(msg => msg.trim()).filter(msg => msg);
            repoSummaries[repoName] = {
              repo: repoName,
              commitCount: messages.length,
              messages: messages.slice(0, 10) // Limit to first 10 messages
            };
          }
          found = true;
          break;
        } catch (err) {
          // Repo exists but no commits or git error - that's OK
        }
      }
    }
  }

  return Object.values(repoSummaries).filter(summary => summary.commitCount > 0);
}

/**
 * Get PR activity summary for the week using GitHub CLI
 */
function getPRSummaryForWeek(config: any, startDate: string, endDate: string): PRSummary[] {
  const repoSummaries: { [repo: string]: PRSummary } = {};
  
  try {
    // Get PRs created by the user during this week
    const prQuery = `author:${config.userName} created:${startDate}..${endDate}`;
    const prResult = execSync(`gh search prs "${prQuery}" --json number,title,repository,state,createdAt --limit 100`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    const prData = JSON.parse(prResult);
    
    for (const pr of prData) {
      const repoName = pr.repository.name;
      
      if (!repoSummaries[repoName]) {
        repoSummaries[repoName] = {
          repo: repoName,
          opened: 0,
          merged: 0,
          closed: 0
        };
      }
      
      if (pr.state === 'MERGED') {
        repoSummaries[repoName].merged++;
      } else if (pr.state === 'CLOSED') {
        repoSummaries[repoName].closed++;
      } else {
        repoSummaries[repoName].opened++;
      }
    }
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not fetch PR activity: ${err}`));
  }
  
  return Object.values(repoSummaries).filter(summary => 
    summary.opened > 0 || summary.merged > 0 || summary.closed > 0
  );
}

/**
 * Generate key accomplishments from the week's data
 */
function generateKeyAccomplishments(commits: CommitSummary[], prs: PRSummary[], logEntries: any[]): string[] {
  const accomplishments: string[] = [];
  
  // Commit-based accomplishments
  const totalCommits = commits.reduce((sum, repo) => sum + repo.commitCount, 0);
  if (totalCommits > 0) {
    accomplishments.push(`Made ${totalCommits} commits across ${commits.length} repositories`);
  }
  
  // PR-based accomplishments
  const totalMerged = prs.reduce((sum, repo) => sum + repo.merged, 0);
  const totalOpened = prs.reduce((sum, repo) => sum + repo.opened, 0);
  
  if (totalMerged > 0) {
    accomplishments.push(`Merged ${totalMerged} pull request${totalMerged !== 1 ? 's' : ''}`);
  }
  
  if (totalOpened > 0) {
    accomplishments.push(`Opened ${totalOpened} new pull request${totalOpened !== 1 ? 's' : ''}`);
  }
  
  // Log-based accomplishments
  if (logEntries.length > 0) {
    accomplishments.push(`Completed ${logEntries.length} logged work items`);
  }
  
  // Repository-specific highlights
  const mostActiveRepo = commits.reduce((max, repo) => 
    repo.commitCount > (max?.commitCount || 0) ? repo : max
  , null as CommitSummary | null);
  
  if (mostActiveRepo && mostActiveRepo.commitCount > 5) {
    accomplishments.push(`Focused development on ${mostActiveRepo.repo} (${mostActiveRepo.commitCount} commits)`);
  }
  
  return accomplishments.length > 0 ? accomplishments : ['Maintained steady development progress'];
}

/**
 * Generate next week focus areas
 */
function generateNextWeekFocus(commits: CommitSummary[], prs: PRSummary[]): string[] {
  const focus: string[] = [];
  
  // Check for open PRs that need attention
  const totalOpen = prs.reduce((sum, repo) => sum + repo.opened, 0);
  if (totalOpen > 0) {
    focus.push(`Review and merge ${totalOpen} pending pull request${totalOpen !== 1 ? 's' : ''}`);
  }
  
  // Suggest continuation of active work
  if (commits.length > 0) {
    const activeRepos = commits.slice(0, 2).map(repo => repo.repo);
    focus.push(`Continue development on ${activeRepos.join(' and ')}`);
  }
  
  // Generic planning items
  focus.push('Plan and prioritize upcoming tasks');
  focus.push('Address any blockers from previous week');
  
  return focus;
}

/**
 * Generate human-readable summary
 */
function generateWeeklySummary(summary: WeeklySummary): string {
  const lines: string[] = [];
  
  const totalCommits = summary.commits.reduce((sum, repo) => sum + repo.commitCount, 0);
  const totalPRs = summary.prActivity.reduce((sum, repo) => sum + repo.merged + repo.opened, 0);
  const totalLogEntries = summary.logEntries.reduce((sum, day) => sum + day.entries.length, 0);
  
  lines.push(`Week of ${summary.startDate}: Productive week with ${totalCommits} commits, ${totalPRs} PRs, and ${totalLogEntries} logged work items.`);
  
  if (summary.commits.length > 0) {
    lines.push(`Development activity across ${summary.commits.length} repositories: ${summary.commits.map(repo => `${repo.repo} (${repo.commitCount})`).join(', ')}.`);
  }
  
  if (summary.prActivity.length > 0) {
    const merged = summary.prActivity.reduce((sum, repo) => sum + repo.merged, 0);
    const opened = summary.prActivity.reduce((sum, repo) => sum + repo.opened, 0);
    if (merged > 0 || opened > 0) {
      lines.push(`GitHub activity: ${merged} PRs merged, ${opened} PRs opened.`);
    }
  }
  
  return lines.join(' ');
}

/**
 * Format weekly summary for display
 */
function formatWeeklySummary(summary: WeeklySummary): string {
  const lines = [
    chalk.bold.blue(`📊 Weekly Summary: ${summary.startDate} to ${summary.endDate}`),
    '',
    chalk.dim(summary.summary),
    '',
    chalk.bold.green('🎯 Key Accomplishments:'),
    ...summary.keyAccomplishments.map(item => `  • ${item}`),
    '',
    chalk.bold.yellow('📅 Next Week Focus:'),
    ...summary.nextWeekFocus.map(item => `  • ${item}`),
    ''
  ];

  // Add detailed breakdown
  if (summary.commits.length > 0) {
    lines.push(chalk.bold.cyan('💻 Development Activity:'));
    for (const repo of summary.commits) {
      lines.push(`  ${repo.repo}: ${repo.commitCount} commits`);
      // Show first few commit messages
      const messages = repo.messages.slice(0, 3);
      for (const msg of messages) {
        lines.push(chalk.dim(`    • ${msg}`));
      }
      if (repo.messages.length > 3) {
        lines.push(chalk.dim(`    ... and ${repo.messages.length - 3} more`));
      }
    }
    lines.push('');
  }

  if (summary.logEntries.length > 0) {
    lines.push(chalk.bold.magenta('📝 Work Log Entries:'));
    for (const day of summary.logEntries) {
      if (day.entries.length > 0) {
        lines.push(`  ${day.date}:`);
        for (const entry of day.entries) {
          lines.push(`    • ${entry}`);
        }
      }
    }
    lines.push('');
  }

  if (summary.standups.length > 0) {
    lines.push(chalk.bold.gray('📋 Standup Activity:'));
    lines.push(`  Generated standups: ${summary.standups.length} days`);
    const activeDays = summary.standups.filter(s => s.hasActivity).length;
    if (activeDays > 0) {
      lines.push(`  Days with git/GitHub activity: ${activeDays}`);
    }
    lines.push('');
  }

  lines.push(chalk.dim(`Generated on ${new Date(summary.generatedAt).toLocaleString()}`));
  
  return lines.join('\n');
}

/**
 * Save weekly summary to disk
 */
function saveWeeklySummary(summary: WeeklySummary): void {
  ensureSummaryDir();
  const filename = `week-${summary.startDate}.json`;
  const filepath = path.join(SUMMARY_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(chalk.dim(`💾 Summary saved to ${filepath}`));
}

/**
 * Load existing weekly summaries
 */
function loadWeeklySummaries(weeksBack: number = 4): WeeklySummary[] {
  if (!fs.existsSync(SUMMARY_DIR)) return [];
  
  const summaries: WeeklySummary[] = [];
  const files = fs.readdirSync(SUMMARY_DIR).filter(f => f.startsWith('week-') && f.endsWith('.json'));
  
  // Sort by date and take the most recent
  files.sort().reverse().slice(0, weeksBack);
  
  for (const file of files) {
    try {
      const filepath = path.join(SUMMARY_DIR, file);
      const content = fs.readFileSync(filepath, 'utf-8');
      summaries.push(JSON.parse(content));
    } catch (err) {
      console.warn(chalk.yellow(`Warning: Could not read summary ${file}: ${err}`));
    }
  }
  
  return summaries;
}

/**
 * Main summary command
 */
export async function summaryCommand(options: { 
  week?: string;
  save?: boolean;
  history?: boolean;
  weeks?: string;
}): Promise<void> {
  try {
    const config = loadConfig();
    
    if (options.history) {
      // Show summary history
      const weeksBack = options.weeks ? parseInt(options.weeks) : 4;
      const summaries = loadWeeklySummaries(weeksBack);
      
      if (summaries.length === 0) {
        console.log(chalk.yellow('No weekly summaries found.'));
        console.log(chalk.dim('Use `tix summary --save` to start generating summaries.'));
        return;
      }

      console.log(chalk.bold.blue(`📊 Weekly Summary History (Last ${summaries.length} weeks)`));
      console.log('');

      for (const summary of summaries) {
        console.log(formatWeeklySummary(summary));
        console.log(chalk.dim('═'.repeat(60)));
      }
      return;
    }
    
    // Determine which week to summarize
    let targetDate: Date;
    if (options.week) {
      targetDate = new Date(options.week);
    } else {
      // Default to last week (Monday to Sunday)
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 7); // Go back a week
    }
    
    const weekStart = getWeekStartDate(targetDate);
    const { start, end } = getWeekDateRange(weekStart);
    
    console.log(chalk.dim(`🔍 Generating summary for week: ${start} to ${end}`));
    
    // Collect all data for the week
    const standups = loadStandupsForWeek(start, end);
    const commits = getCommitSummaryForWeek(config, start, end);
    const logEntries = getLogEntriesForDateRange(start, end);
    const prActivity = getPRSummaryForWeek(config, start, end);
    
    // Group log entries by date
    const logEntriesByDate: { [date: string]: string[] } = {};
    for (const entry of logEntries) {
      if (!logEntriesByDate[entry.date]) {
        logEntriesByDate[entry.date] = [];
      }
      logEntriesByDate[entry.date].push(entry.entry);
    }
    
    const logSummary: LogEntrySummary[] = Object.keys(logEntriesByDate).map(date => ({
      date,
      entries: logEntriesByDate[date]
    })).sort((a, b) => a.date.localeCompare(b.date));
    
    // Generate summary
    const summary: WeeklySummary = {
      weekOf: start,
      startDate: start,
      endDate: end,
      author: config.userName,
      generatedAt: new Date().toISOString(),
      standups,
      commits,
      logEntries: logSummary,
      prActivity,
      summary: '',
      keyAccomplishments: generateKeyAccomplishments(commits, prActivity, logEntries),
      nextWeekFocus: generateNextWeekFocus(commits, prActivity)
    };
    
    summary.summary = generateWeeklySummary(summary);
    
    // Display summary
    console.log(formatWeeklySummary(summary));
    
    // Save if requested
    if (options.save) {
      saveWeeklySummary(summary);
    } else {
      console.log('');
      console.log(chalk.dim('💡 Use --save to persist this summary'));
      console.log(chalk.dim('💡 Use --history to view previous summaries'));
    }
    
  } catch (err: any) {
    throw new Error(`Failed to generate summary: ${err.message}`);
  }
}