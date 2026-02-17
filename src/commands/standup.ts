import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../lib/config';
import { checkGhCli } from '../lib/github';
import { parsePRUrl } from '../lib/github';
import type { EqConfig } from '../types';

interface StandupEntry {
  date: string;
  yesterday: string[];
  today: string[];
  blockers: string[];
  commits: CommitInfo[];
  prs: PRActivity[];
  issues: IssueActivity[];
}

interface CommitInfo {
  repo: string;
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface PRActivity {
  repo: string;
  number: number;
  title: string;
  action: 'opened' | 'merged' | 'reviewed' | 'closed';
  url: string;
  date: string;
}

interface IssueActivity {
  repo: string;
  number: number;
  title: string;
  action: 'closed' | 'opened';
  url: string;
  date: string;
}

const STANDUP_DIR = path.join(os.homedir(), '.tix', 'standups');
const REPOS_CONFIG_PATH = path.join(os.homedir(), '.tix', 'repos.json');

/**
 * Ensure standup directory exists
 */
function ensureStandupDir(): void {
  if (!fs.existsSync(STANDUP_DIR)) {
    fs.mkdirSync(STANDUP_DIR, { recursive: true });
  }
}

/**
 * Get configured repositories to scan
 */
function getConfiguredRepos(config: EqConfig): string[] {
  const defaultRepos = [
    'em-boxes-events',
    'em-transactions-api', 
    'em-contracts',
    'tix',
    'tix-kanban'
  ];

  if (fs.existsSync(REPOS_CONFIG_PATH)) {
    try {
      const reposConfig = JSON.parse(fs.readFileSync(REPOS_CONFIG_PATH, 'utf-8'));
      return reposConfig.repos || defaultRepos;
    } catch (err) {
      console.warn(chalk.yellow('Warning: Could not read repos config, using defaults'));
    }
  }

  return defaultRepos.map(repo => `${config.githubOrg}/${repo}`);
}

/**
 * Get git commits from the last 24 hours for a repository
 */
function getRecentCommits(repoPath: string, hoursAgo: number = 24): CommitInfo[] {
  try {
    const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const cmd = `git log --since="${since}" --pretty=format:"%H|%s|%an|%ai" --no-merges`;
    
    const output = execSync(cmd, { 
      cwd: repoPath, 
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();

    if (!output) return [];

    const repoName = path.basename(repoPath);
    return output.split('\n').map(line => {
      const [hash, message, author, date] = line.split('|');
      return {
        repo: repoName,
        hash: hash.substring(0, 8),
        message: message.trim(),
        author: author.trim(),
        date: new Date(date).toISOString()
      };
    });
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not get commits from ${repoPath}: ${err}`));
    return [];
  }
}

/**
 * Get GitHub activity using gh CLI
 */
function getGitHubActivity(config: EqConfig, hoursAgo: number = 24): { prs: PRActivity[], issues: IssueActivity[] } {
  const prs: PRActivity[] = [];
  const issues: IssueActivity[] = [];
  
  try {
    const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    
    // Get PRs created, merged, or reviewed by the user
    const prQuery = `author:${config.userName} created:>=${since.split('T')[0]}`;
    const prResult = execSync(`gh search prs "${prQuery}" --json number,title,repository,state,updatedAt,url --limit 50`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    const prData = JSON.parse(prResult);
    for (const pr of prData) {
      const action = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'opened';
      prs.push({
        repo: pr.repository.name,
        number: pr.number,
        title: pr.title,
        action,
        url: pr.url,
        date: pr.updatedAt
      });
    }

    // Get issues closed by the user
    const issueQuery = `assignee:${config.userName} closed:>=${since.split('T')[0]}`;
    const issueResult = execSync(`gh search issues "${issueQuery}" --json number,title,repository,state,closedAt,url --limit 50`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    const issueData = JSON.parse(issueResult);
    for (const issue of issueData) {
      if (issue.state === 'CLOSED' && issue.closedAt) {
        issues.push({
          repo: issue.repository.name,
          number: issue.number,
          title: issue.title,
          action: 'closed',
          url: issue.url,
          date: issue.closedAt
        });
      }
    }

  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not fetch GitHub activity: ${err}`));
  }

  return { prs, issues };
}

/**
 * Scan local repositories for git activity
 */
function scanLocalRepos(config: EqConfig, hoursAgo: number): CommitInfo[] {
  const allCommits: CommitInfo[] = [];
  const configuredRepos = getConfiguredRepos(config);
  
  // Look for repos in common locations
  const searchPaths = [
    path.join(os.homedir(), 'repos'),
    path.join(os.homedir(), 'code'),
    path.join(os.homedir(), 'projects'),
    '/root/clawd/repos',
    process.cwd()
  ];

  for (const repoName of configuredRepos) {
    const shortName = repoName.split('/').pop() || repoName;
    let found = false;

    for (const searchPath of searchPaths) {
      const repoPath = path.join(searchPath, shortName);
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        const commits = getRecentCommits(repoPath, hoursAgo);
        allCommits.push(...commits);
        found = true;
        break;
      }
    }

    if (!found) {
      console.warn(chalk.yellow(`Warning: Could not find local repo: ${shortName}`));
    }
  }

  return allCommits;
}

/**
 * Generate standup content from activity data
 */
function generateStandup(commits: CommitInfo[], prs: PRActivity[], issues: IssueActivity[]): StandupEntry {
  const today = new Date().toISOString().split('T')[0];
  
  const yesterday: string[] = [];
  const todayItems: string[] = [];
  const blockers: string[] = [];

  // Process commits
  commits.forEach(commit => {
    yesterday.push(`${commit.repo}: ${commit.message} (${commit.hash})`);
  });

  // Process PR activity
  prs.forEach(pr => {
    const action = pr.action === 'opened' ? 'Opened' : pr.action === 'merged' ? 'Merged' : 'Closed';
    yesterday.push(`${action} PR #${pr.number} in ${pr.repo}: ${pr.title}`);
  });

  // Process issue activity
  issues.forEach(issue => {
    yesterday.push(`Closed issue #${issue.number} in ${issue.repo}: ${issue.title}`);
  });

  // Add default "today" items based on current work
  if (commits.length > 0 || prs.length > 0) {
    todayItems.push('Continue work on active tasks');
    todayItems.push('Review any pending PRs');
  }

  // Check for potential blockers (PRs waiting for review, failing CI, etc.)
  // This is a simplified version - in practice, you'd query PR status
  if (prs.some(pr => pr.action === 'opened')) {
    blockers.push('Some PRs may be waiting for review');
  }

  if (yesterday.length === 0) {
    yesterday.push('No git or GitHub activity found in the last 24 hours');
  }

  if (todayItems.length === 0) {
    todayItems.push('Planning tasks for today');
  }

  if (blockers.length === 0) {
    blockers.push('None at this time');
  }

  return {
    date: today,
    yesterday,
    today: todayItems,
    blockers,
    commits,
    prs,
    issues
  };
}

/**
 * Format standup for display
 */
function formatStandup(entry: StandupEntry): string {
  const lines = [
    chalk.bold.blue(`📋 Standup for ${entry.date}`),
    '',
    chalk.bold.green('✅ Yesterday:'),
    ...entry.yesterday.map(item => `  • ${item}`),
    '',
    chalk.bold.yellow('🎯 Today:'),
    ...entry.today.map(item => `  • ${item}`),
    '',
    chalk.bold.red('🚫 Blockers:'),
    ...entry.blockers.map(item => `  • ${item}`),
    ''
  ];

  if (entry.commits.length > 0 || entry.prs.length > 0 || entry.issues.length > 0) {
    lines.push(chalk.dim('--- Raw Activity Data ---'));
    if (entry.commits.length > 0) {
      lines.push(chalk.dim(`Commits: ${entry.commits.length}`));
    }
    if (entry.prs.length > 0) {
      lines.push(chalk.dim(`PR activity: ${entry.prs.length}`));
    }
    if (entry.issues.length > 0) {
      lines.push(chalk.dim(`Issues closed: ${entry.issues.length}`));
    }
  }

  return lines.join('\n');
}

/**
 * Save standup entry to disk
 */
function saveStandup(entry: StandupEntry): void {
  ensureStandupDir();
  const filename = `${entry.date}.json`;
  const filepath = path.join(STANDUP_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf-8');
  console.log(chalk.dim(`💾 Standup saved to ${filepath}`));
}

/**
 * Load standup entries for the past week
 */
function loadWeekHistory(): StandupEntry[] {
  if (!fs.existsSync(STANDUP_DIR)) return [];
  
  const entries: StandupEntry[] = [];
  const files = fs.readdirSync(STANDUP_DIR).filter(f => f.endsWith('.json'));
  
  // Get files from the last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  for (const file of files) {
    const date = file.replace('.json', '');
    const fileDate = new Date(date);
    
    if (fileDate >= weekAgo) {
      try {
        const filepath = path.join(STANDUP_DIR, file);
        const content = fs.readFileSync(filepath, 'utf-8');
        entries.push(JSON.parse(content));
      } catch (err) {
        console.warn(chalk.yellow(`Warning: Could not read ${file}: ${err}`));
      }
    }
  }
  
  return entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * Main standup command
 */
export async function standupCommand(options: { save?: boolean; week?: boolean; hours?: string }): Promise<void> {
  try {
    const config = loadConfig();
    
    if (!checkGhCli()) {
      throw new Error('GitHub CLI not found or not authenticated. Run `gh auth login` first.');
    }

    const hoursAgo = options.hours ? parseInt(options.hours) : 24;

    if (options.week) {
      // Show week history
      const weekEntries = loadWeekHistory();
      if (weekEntries.length === 0) {
        console.log(chalk.yellow('No standup history found for the past week.'));
        console.log(chalk.dim('Use `tix standup --save` to start building history.'));
        return;
      }

      console.log(chalk.bold.blue(`📊 Standup History (Last ${weekEntries.length} days)`));
      console.log('');

      for (const entry of weekEntries) {
        console.log(formatStandup(entry));
        console.log(chalk.dim('─'.repeat(50)));
      }
      return;
    }

    console.log(chalk.dim('🔍 Scanning git repositories and GitHub activity...'));
    
    // Collect activity data
    const commits = scanLocalRepos(config, hoursAgo);
    const { prs, issues } = getGitHubActivity(config, hoursAgo);
    
    // Generate standup
    const standup = generateStandup(commits, prs, issues);
    
    // Display standup
    console.log(formatStandup(standup));
    
    // Save if requested
    if (options.save) {
      saveStandup(standup);
    }

    // Show save hint if not saving
    if (!options.save && !options.week) {
      console.log('');
      console.log(chalk.dim('💡 Use --save to persist this standup for history tracking'));
      console.log(chalk.dim('💡 Use --week to view your standup history'));
    }

  } catch (err: any) {
    throw new Error(`Failed to generate standup: ${err.message}`);
  }
}