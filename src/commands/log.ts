import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../lib/config';

interface LogEntry {
  timestamp: string;
  date: string;
  entry: string;
  author: string;
}

const LOG_DIR = path.join(os.homedir(), '.tix', 'logs');

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Get the log file path for a given date
 */
function getLogFilePath(date: string): string {
  return path.join(LOG_DIR, `${date}.json`);
}

/**
 * Load existing log entries for a date
 */
function loadLogEntries(date: string): LogEntry[] {
  const logFile = getLogFilePath(date);
  if (!fs.existsSync(logFile)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not read log file ${logFile}: ${err}`));
    return [];
  }
}

/**
 * Save log entries to disk
 */
function saveLogEntries(date: string, entries: LogEntry[]): void {
  ensureLogDir();
  const logFile = getLogFilePath(date);
  fs.writeFileSync(logFile, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Add a new log entry
 */
function addLogEntry(message: string): void {
  const config = loadConfig();
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const timestamp = now.toISOString();
  
  const entry: LogEntry = {
    timestamp,
    date,
    entry: message,
    author: config.userName
  };
  
  const existingEntries = loadLogEntries(date);
  existingEntries.push(entry);
  saveLogEntries(date, existingEntries);
  
  console.log(chalk.green(`📝 Logged: ${message}`));
  console.log(chalk.dim(`   ${now.toLocaleTimeString()}`));
}

/**
 * Show log entries for a date or date range
 */
function showLogs(options: { days?: number; date?: string }): void {
  const dates: string[] = [];
  
  if (options.date) {
    dates.push(options.date);
  } else {
    const daysBack = options.days || 1;
    for (let i = 0; i < daysBack; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      dates.push(date.toISOString().split('T')[0]);
    }
  }
  
  let totalEntries = 0;
  
  for (const date of dates) {
    const entries = loadLogEntries(date);
    if (entries.length === 0) {
      if (dates.length === 1) {
        console.log(chalk.yellow(`No log entries found for ${date}`));
      }
      continue;
    }
    
    console.log(chalk.bold.blue(`📋 Log entries for ${date}`));
    console.log('');
    
    entries.forEach((entry, index) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`  ${index + 1}. ${entry.entry}`);
      console.log(chalk.dim(`     ${time} by ${entry.author}`));
    });
    
    console.log('');
    totalEntries += entries.length;
  }
  
  if (dates.length > 1 && totalEntries > 0) {
    console.log(chalk.dim(`Total entries: ${totalEntries} across ${dates.length} days`));
  }
}

/**
 * Get all log entries for a date range (used by summary command)
 */
export function getLogEntriesForDateRange(startDate: string, endDate: string): LogEntry[] {
  const allEntries: LogEntry[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const entries = loadLogEntries(dateStr);
    allEntries.push(...entries);
  }
  
  return allEntries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/**
 * Main log command
 */
export async function logCommand(message?: string, options?: { show?: boolean; days?: string; date?: string }): Promise<void> {
  try {
    if (message) {
      // Add a log entry
      addLogEntry(message);
    } else if (options?.show) {
      // Show log entries
      const days = options.days ? parseInt(options.days) : undefined;
      showLogs({ days, date: options.date });
    } else {
      // Interactive mode - prompt for input
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      console.log(chalk.blue('📝 Quick work log entry:'));
      rl.question('What did you work on? ', (answer: string) => {
        if (answer.trim()) {
          addLogEntry(answer.trim());
        } else {
          console.log(chalk.yellow('No entry added.'));
        }
        rl.close();
      });
    }
  } catch (err: any) {
    throw new Error(`Failed to process log command: ${err.message}`);
  }
}