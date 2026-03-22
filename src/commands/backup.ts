import chalk from 'chalk';
import { execSync, exec as execCallback } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import inquirer from 'inquirer';
import { loadConfig, saveConfig } from '../lib/config';
import { getLogEntriesForDateRange } from './log';

const execAsync = promisify(execCallback);

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Load daily notes from the backup directory (if they exist)
 */
function loadDailyNotes(backupPath: string, date: string): string | null {
  const notesFile = path.join(backupPath, 'notes', `${date}.md`);
  if (!fs.existsSync(notesFile)) {
    return null;
  }
  
  try {
    return fs.readFileSync(notesFile, 'utf-8');
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not read notes file ${notesFile}: ${err}`));
    return null;
  }
}

/**
 * Generate markdown for a daily backup file
 */
function generateDailyMarkdown(date: string, backupPath: string): string {
  const logEntries = getLogEntriesForDateRange(date, date);
  
  // Build activity log section
  const activityLog = logEntries.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    return `- ${time} - ${entry.entry}`;
  }).join('\n');
  
  // Load existing daily notes if they exist
  const existingNotes = loadDailyNotes(backupPath, date);
  const notesSection = existingNotes || '*(No notes for this date)*';
  
  // Generate summary
  const tasksCreated = logEntries.filter(e => 
    e.entry.toLowerCase().includes('created') || 
    e.entry.toLowerCase().includes('started')
  ).length;
  
  const tasksCompleted = logEntries.filter(e => 
    e.entry.toLowerCase().includes('completed') || 
    e.entry.toLowerCase().includes('finished') ||
    e.entry.toLowerCase().includes('merged')
  ).length;
  
  // Build final markdown
  return `# ${date}

## Activity Log
${activityLog || '*(No activity logged)*'}

## Daily Notes
${notesSection}

## Summary
- Tasks created: ${tasksCreated}
- Tasks completed: ${tasksCompleted}
- Total log entries: ${logEntries.length}
`;
}

/**
 * Ensure backup directory structure exists
 */
function ensureBackupStructure(backupPath: string): void {
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }
  
  const notesDir = path.join(backupPath, 'notes');
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }
}

/**
 * Initialize git repo if it doesn't exist
 */
function ensureGitRepo(backupPath: string, silent: boolean = false): void {
  const gitDir = path.join(backupPath, '.git');
  if (!fs.existsSync(gitDir)) {
    if (!silent) {
      console.log(chalk.blue('Initializing git repository...'));
    }
    execSync('git init', { cwd: backupPath, stdio: 'pipe' });
    execSync('git branch -M main', { cwd: backupPath, stdio: 'pipe' });
    if (!silent) {
      console.log(chalk.green('✓ Git repository initialized'));
    }
  }
}

/**
 * Commit backup files to git
 */
function commitBackup(backupPath: string, date: string, auto: boolean): void {
  try {
    // Check if there are changes to commit
    const status = execSync('git status --porcelain', { 
      cwd: backupPath, 
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();
    
    if (!status) {
      if (!auto) {
        console.log(chalk.dim('No changes to commit'));
      }
      return;
    }
    
    // Stage all changes
    execSync('git add .', { cwd: backupPath, stdio: 'pipe' });
    
    // Commit
    const commitMsg = `Backup for ${date}`;
    execSync(`git commit -m "${commitMsg}"`, { cwd: backupPath, stdio: 'pipe' });
    
    if (!auto) {
      console.log(chalk.green(`✓ Committed: ${commitMsg}`));
    }
  } catch (err: any) {
    if (!auto) {
      console.warn(chalk.yellow(`Warning: Could not commit changes: ${err.message}`));
    }
  }
}

/**
 * Push to remote if configured
 */
function pushBackup(backupPath: string, auto: boolean): void {
  try {
    execSync('git push', { cwd: backupPath, stdio: 'pipe' });
    if (!auto) {
      console.log(chalk.green('✓ Pushed to remote'));
    }
  } catch (err: any) {
    if (!auto) {
      console.warn(chalk.yellow(`Warning: Could not push to remote: ${err.message}`));
      console.log(chalk.dim('You may need to set up a remote first:'));
      console.log(chalk.dim('  git remote add origin <url>'));
      console.log(chalk.dim('  git push -u origin main'));
    }
  }
}

/**
 * Main backup command
 */
export async function backupCommand(options?: { 
  auto?: boolean; 
  date?: string;
  days?: string;
  setup?: boolean;
}): Promise<void> {
  try {
    const config = loadConfig();
    
    // Setup mode: configure backup settings
    if (options?.setup) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'path',
          message: 'Backup directory path:',
          default: config.backup?.path || path.join(process.env.HOME || '~', 'career-notes'),
        },
        {
          type: 'confirm',
          name: 'autoPush',
          message: 'Auto-push to GitHub after backup?',
          default: config.backup?.autoPush || false,
        },
      ]);
      
      // Update config
      const updatedConfig = {
        ...config,
        backup: {
          ...config.backup,
          enabled: true,
          path: answers.path,
          autoPush: answers.autoPush,
          frequency: config.backup?.frequency || 'daily',
          maxBackups: config.backup?.maxBackups || 365,
        },
      };
      
      saveConfig(updatedConfig);
      console.log(chalk.green('✓ Backup settings saved'));
      console.log(chalk.dim(`Backup path: ${answers.path}`));
      console.log(chalk.dim(`Auto-push: ${answers.autoPush ? 'enabled' : 'disabled'}`));
      return;
    }
    
    // Check if backup is configured
    if (!config.backup || !config.backup.path) {
      console.error(chalk.red('Backup not configured. Run `tix backup --setup` first.'));
      process.exit(1);
    }
    
    const backupPath = config.backup.path;
    const auto = options?.auto || false;
    
    // BUG 1 FIX: Validate --date option against shell injection
    if (options?.date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(options.date)) {
        throw new Error(`Invalid date format: '${options.date}'. Expected YYYY-MM-DD (e.g., 2026-03-22)`);
      }
    }
    
    // Determine dates to backup
    const dates: string[] = [];
    if (options?.date) {
      dates.push(options.date);
    } else if (options?.days) {
      const daysCount = parseInt(options.days);
      for (let i = 0; i < daysCount; i++) {
        const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        dates.push(formatDate(date));
      }
    } else {
      // Default: today
      dates.push(formatDate(new Date()));
    }
    
    // Ensure backup directory structure
    ensureBackupStructure(backupPath);
    
    // Ensure git repository (pass silent flag)
    ensureGitRepo(backupPath, auto);
    
    if (!auto) {
      console.log(chalk.blue('📦 Backing up career notes...'));
    }
    
    // Generate and save backups
    for (const date of dates) {
      const markdown = generateDailyMarkdown(date, backupPath);
      const outputFile = path.join(backupPath, `${date}.md`);
      fs.writeFileSync(outputFile, markdown, 'utf-8');
      
      if (!auto) {
        console.log(chalk.green(`✓ Generated backup for ${date}`));
      }
    }
    
    // Commit changes
    const dateStr = dates.length === 1 ? dates[0] : `${dates.length} days`;
    commitBackup(backupPath, dateStr, auto);
    
    // Push if enabled
    if (config.backup?.autoPush) {
      pushBackup(backupPath, auto);
    }
    
    if (!auto) {
      console.log(chalk.green('✓ Backup complete'));
      console.log(chalk.dim(`Location: ${backupPath}`));
    }
  } catch (err: any) {
    throw new Error(`Failed to backup: ${err.message}`);
  }
}

// ============================================================
// RESTORE COMMAND
// ============================================================

const STORAGE_DIR = path.join(process.env.HOME || '~', '.tix-kanban');

// Strict pattern for git refs (commit SHAs, branch names, tags)
// Allows: alphanumeric, underscores, hyphens, dots, forward slashes
// Max 200 chars to prevent DoS
const GIT_REF_PATTERN = /^[a-zA-Z0-9_\-\.\/]{1,200}$/;

/**
 * Validate a git ref/commit to prevent shell injection
 */
function validateGitRef(ref: string): void {
  if (!GIT_REF_PATTERN.test(ref)) {
    throw new Error(
      `Invalid git ref: '${ref}'. Must match pattern: alphanumeric, underscore, hyphen, dot, forward slash (1-200 chars)`
    );
  }
}

interface RestoreOptions {
  backupDir: string; // Now required, not optional
  dryRun: boolean;
  fromCommit?: string;
}

/**
 * Check if git is installed
 */
async function isGitInstalled(): Promise<boolean> {
  try {
    await execAsync('git --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a git repository
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all files in a directory recursively
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip .git directory
      if (entry.name === '.git') {
        continue;
      }
      
      if (entry.isDirectory()) {
        const subFiles = await getAllFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore errors for missing directories
  }
  
  return files;
}

/**
 * Restore files from backup directory to the live location
 */
export async function restoreCommand(options: RestoreOptions): Promise<void> {
  // BUG 1 FIX: Require backupDir and validate it's not the same as restore destination
  if (!options.backupDir) {
    console.error('❌ Error: --backup-dir is required. Cannot determine backup location.');
    console.log('Usage: tix restore --backup-dir <path>');
    process.exit(1);
  }

  const backupDir = options.backupDir;
  const dryRun = options.dryRun;
  const fromCommit = options.fromCommit;

  // Validate backupDir is not the same as STORAGE_DIR (restore destination)
  const resolvedBackupDir = path.resolve(backupDir);
  const resolvedStorageDir = path.resolve(STORAGE_DIR);
  
  if (resolvedBackupDir === resolvedStorageDir) {
    console.error(`❌ Error: backupDir cannot be the same as the restore destination (${STORAGE_DIR}).`);
    console.error('This would copy files over themselves, causing data loss.');
    console.log(`\nProvide a different backup directory, e.g.:`);
    console.log(`  tix restore --backup-dir ~/.tix-backup`);
    process.exit(1);
  }

  // BUG 2 FIX: Validate fromCommit against shell injection
  if (fromCommit) {
    validateGitRef(fromCommit);
  }
  
  console.log('\n🔄 Tix-Kanban Backup Restore');
  console.log('============================\n');
  
  // Validate backup directory
  try {
    await fs.promises.access(backupDir);
  } catch {
    console.error(`❌ Error: Backup directory not found: ${backupDir}`);
    process.exit(1);
  }
  
  // Check if git is available in backup dir
  const gitInstalled = await isGitInstalled();
  const isGitBackup = await isGitRepo(backupDir);
  
  // Handle --from-commit: wrap in try/finally to ensure checkout is reverted
  let needsRevert = false;
  
  if (fromCommit) {
    if (!gitInstalled) {
      console.error('❌ Error: Git is not installed. Cannot restore from commit.');
      process.exit(1);
    }
    
    if (!isGitBackup) {
      console.error('❌ Error: Backup directory is not a git repository. Cannot restore from commit.');
      process.exit(1);
    }
    
    console.log(`📌 Restoring from git commit: ${fromCommit}`);
    
    try {
      // Verify the commit exists
      await execAsync(`git cat-file -t ${fromCommit}`, { cwd: backupDir });
    } catch {
      console.error(`❌ Error: Commit not found: ${fromCommit}`);
      process.exit(1);
    }
    
    // Checkout the specific commit temporarily - wrap in try/finally to ensure revert
    try {
      await execAsync(`git checkout ${fromCommit} -- .`, { cwd: backupDir });
      console.log('✅ Checked out files from commit');
      needsRevert = true;
    } catch (err: any) {
      console.error(`❌ Error checking out commit: ${err.message}`);
      process.exit(1);
    }
  }

  // Get files to restore
  const files = await getAllFiles(backupDir);
  
  if (files.length === 0) {
    console.log('ℹ️  No files found in backup directory.');
    return;
  }
  
  // Calculate relative paths and target paths
  const filesToRestore = files.map(file => ({
    source: file,
    relative: path.relative(backupDir, file),
    target: path.join(STORAGE_DIR, path.relative(backupDir, file))
  }));
  
  // Show what would be restored
  console.log(`📁 Files to restore from: ${backupDir}`);
  console.log(`📁 Target directory: ${STORAGE_DIR}`);
  console.log(`📋 Total files: ${filesToRestore.length}\n`);
  
  if (dryRun) {
    console.log('🔍 DRY RUN - Files that would be restored:\n');
    for (const file of filesToRestore) {
      console.log(`  ${file.relative}`);
    }
    console.log('\n✅ Dry run complete. No files were modified.');
    
    // Revert checkout if we checked out a commit
    if (needsRevert) {
      try {
        await execAsync('git checkout HEAD -- .', { cwd: backupDir });
        console.log('🔄 Reverted to HEAD after dry-run.');
      } catch {
        console.warn('⚠️  Could not revert to HEAD. You may need to manually run: git checkout HEAD -- .');
      }
    }
    
    return;
  }
  
  // Confirmation prompt
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: '⚠️  Are you sure? This will overwrite your current data in ~/.tix-kanban.',
      default: false
    }
  ]);
  
  if (!answers.confirm) {
    console.log('\n❌ Restore cancelled.');
    
    // If we checked out a commit, restore to HEAD
    if (fromCommit && isGitBackup) {
      try {
        await execAsync('git checkout HEAD -- .', { cwd: backupDir });
        console.log('🔄 Reverted to HEAD after cancelled restore.');
      } catch {
        console.warn('⚠️  Could not revert to HEAD. You may need to manually run: git checkout HEAD -- .');
      }
    }
    
    return;
  }
  
  // Perform the restore
  console.log('\n🔄 Restoring files...\n');
  
  let restoredCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (const file of filesToRestore) {
    try {
      // Ensure target directory exists
      const targetDir = path.dirname(file.target);
      await fs.promises.mkdir(targetDir, { recursive: true });
      
      // Check if target file exists and has identical content - skip if so
      let shouldSkip = false;
      try {
        const sourceContent = await fs.promises.readFile(file.source);
        const targetContent = await fs.promises.readFile(file.target);
        if (sourceContent.equals(targetContent)) {
          shouldSkip = true;
        }
      } catch {
        // Target doesn't exist - we'll copy it
        shouldSkip = false;
      }
      
      if (shouldSkip) {
        skippedCount++;
        continue;
      }
      
      // Copy file
      await fs.promises.copyFile(file.source, file.target);
      restoredCount++;
    } catch (err: any) {
      errorCount++;
      console.warn(`  ⚠️  Failed to restore ${file.relative}: ${err.message}`);
    }
  }
  
  console.log(`\n✅ Restore complete!`);
  console.log(`   📄 Restored: ${restoredCount} files`);
  if (skippedCount > 0) {
    console.log(`   ⏭️  Skipped: ${skippedCount} files`);
  }
  if (errorCount > 0) {
    console.log(`   ❌ Errors: ${errorCount} files`);
  }
  
  // If we checked out a commit, restore to HEAD
  if (fromCommit && isGitBackup) {
    try {
      await execAsync('git checkout HEAD -- .', { cwd: backupDir });
      console.log('\n🔄 Reverted to HEAD (restore complete).');
    } catch {
      console.warn('\n⚠️  Note: Could not revert to HEAD. You may want to manually run: git checkout HEAD -- .');
    }
  }
}
