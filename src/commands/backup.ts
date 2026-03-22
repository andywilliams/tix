import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import inquirer from 'inquirer';
import { existsSync } from 'fs';

const execAsync = promisify(execCallback);

const STORAGE_DIR = path.join(os.homedir(), '.tix-kanban');
const TIX_KANBAN_SETTINGS_FILE = path.join(STORAGE_DIR, 'user-settings.json');
const TIX_KANBAN_PROJECT_DIR = process.env.TIX_KANBAN_PROJECT_DIR || path.join(os.homedir(), 'tix-kanban');

interface RestoreOptions {
  backupDir?: string;
  dryRun: boolean;
  fromCommit?: string;
}

// Default backup categories - all enabled by default
const DEFAULT_BACKUP_CATEGORIES: Record<string, boolean> = {
  tasks: true,
  chat: true,
  userSettings: true,
  githubSettings: true,
  personas: true,
  agentMemories: true,
  souls: true,
  knowledge: true,
  reports: true,
  pipelines: true,
  autoReviewConfig: true,
  slack: true,
  reviewStates: true,
};

// Map each category to the top-level paths it occupies inside STORAGE_DIR
const CATEGORY_PATHS: Record<string, string[]> = {
  tasks: ['tasks'],
  chat: ['chat'],
  userSettings: ['user-settings.json'],
  githubSettings: ['github-settings.json'],
  personas: ['personas'],
  agentMemories: ['agent-memories'],
  souls: ['souls'],
  knowledge: ['knowledge'],
  reports: ['reports'],
  pipelines: ['pipelines'],
  autoReviewConfig: ['auto-review-config.json', 'auto-review'],
  slack: ['slack'],
  reviewStates: ['review-states.json', 'review-states'],
};

/**
 * Read user settings from the tix-kanban settings file
 */
async function getTixKanbanSettings(): Promise<Record<string, any>> {
  try {
    const content = await fs.readFile(TIX_KANBAN_SETTINGS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return {};
  }
}

/**
 * Save user settings to the tix-kanban settings file
 */
async function saveTixKanbanSettings(settings: Record<string, any>): Promise<void> {
  await fs.writeFile(TIX_KANBAN_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Get current backup categories with defaults applied
 */
async function getBackupCategories(): Promise<Record<string, boolean>> {
  const settings = await getTixKanbanSettings();
  const categories = settings.backupCategories || {};
  return {
    ...DEFAULT_BACKUP_CATEGORIES,
    ...categories,
  };
}

/**
 * Update backup categories
 */
async function updateBackupCategories(categories: Record<string, boolean>): Promise<Record<string, boolean>> {
  const settings = await getTixKanbanSettings();
  
  if (!settings.backupCategories) {
    settings.backupCategories = {};
  }
  
  settings.backupCategories = { ...settings.backupCategories, ...categories };
  await saveTixKanbanSettings(settings);
  
  return {
    ...DEFAULT_BACKUP_CATEGORIES,
    ...settings.backupCategories,
  };
}

/**
 * Show backup categories status
 */
export async function showBackupCategories(): Promise<void> {
  console.log('\n📋 Backup Categories Status');
  console.log('============================\n');
  
  const categories = await getBackupCategories();
  
  for (const [category, enabled] of Object.entries(categories)) {
    const status = enabled ? '✅ ON' : '❌ OFF';
    console.log(`  ${status}  ${category}`);
  }
  
  console.log('\n');
}

/**
 * Toggle a specific backup category
 */
export async function toggleBackupCategory(category: string, enable: boolean): Promise<void> {
  const validCategories = Object.keys(DEFAULT_BACKUP_CATEGORIES);
  
  if (!validCategories.includes(category)) {
    console.error(`\n❌ Invalid category: ${category}`);
    console.log(`\nValid categories:`);
    for (const cat of validCategories) {
      console.log(`  - ${cat}`);
    }
    console.log('');
    process.exit(1);
  }
  
  const categories = await updateBackupCategories({ [category]: enable });
  const status = enable ? '✅ enabled' : '❌ disabled';
  
  console.log(`\n📋 Backup category '${category}' is now ${status}.`);
  console.log('\nCurrent status:');
  for (const [cat, enabled] of Object.entries(categories)) {
    const catStatus = enabled ? '✅ ON' : '❌ OFF';
    console.log(`  ${catStatus}  ${cat}`);
  }
  console.log('');
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
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
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
  const backupDir = options.backupDir || STORAGE_DIR;
  const dryRun = options.dryRun;
  const fromCommit = options.fromCommit;
  
  console.log('\n🔄 Tix-Kanban Backup Restore');
  console.log('============================\n');
  
  // Validate backup directory
  try {
    await fs.access(backupDir);
  } catch {
    console.error(`❌ Error: Backup directory not found: ${backupDir}`);
    process.exit(1);
  }
  
  // Check if git is available in backup dir
  const gitInstalled = await isGitInstalled();
  const isGitBackup = await isGitRepo(backupDir);
  
  // Handle --from-commit option
  if (fromCommit) {
    if (!gitInstalled) {
      console.error('❌ Error: Git is not installed. Cannot restore from commit.');
      process.exit(1);
    }
    
    if (!isGitBackup) {
      console.error('❌ Error: Backup directory is not a git repository. Cannot restore from commit.');
      process.exit(1);
    }
    
    // Validate fromCommit to prevent shell injection
    const validCommitRef = /^[a-zA-Z0-9._\-\/^~@{}:]+$/;
    if (!validCommitRef.test(fromCommit)) {
      console.error(`❌ Error: Invalid commit reference: ${fromCommit}`);
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
    
    // Checkout the specific commit temporarily
    try {
      await execAsync(`git checkout ${fromCommit} -- .`, { cwd: backupDir });
      console.log('✅ Checked out files from commit');
    } catch (err: any) {
      console.error(`❌ Error checking out commit: ${err.message}`);
      process.exit(1);
    }
  }
  
  // Helper to revert checked-out commit when we need to exit early
  const revertCommitCheckout = async () => {
    if (fromCommit && isGitBackup) {
      try {
        await execAsync('git checkout HEAD -- .', { cwd: backupDir });
      } catch {
        console.warn('⚠️  Could not revert to HEAD. You may need to manually run: git checkout HEAD -- .');
      }
    }
  };

  // Get files to restore
  const files = await getAllFiles(backupDir);
  
  if (files.length === 0) {
    console.log('ℹ️  No files found in backup directory.');
    await revertCommitCheckout();
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
    await revertCommitCheckout();
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
      await fs.mkdir(targetDir, { recursive: true });
      
      // Copy file
      await fs.copyFile(file.source, file.target);
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

// ============================================================================
// Manual Backup Command
// ============================================================================

interface BackupSettings {
  backupDir?: string;
}

/**
 * Read backupDir from tix-kanban user settings
 */
async function getBackupDirFromSettings(): Promise<string | null> {
  try {
    const content = await fs.readFile(TIX_KANBAN_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(content);
    
    // Check for backup.backupDir in the settings
    if (settings.backup?.backupDir) {
      // Expand ~ to home directory
      return settings.backup.backupDir.replace(/^~/, os.homedir());
    }
    
    return null;
  } catch (error) {
    // File doesn't exist or is invalid
    return null;
  }
}

/**
 * Copy a directory recursively using fs.cp (Node 16.7+)
 */
async function copyDirectory(
  source: string,
  destination: string,
  filter?: (src: string, dest: string) => boolean
): Promise<{ success: boolean; copied: number; errors: string[] }> {
  const errors: string[] = [];
  let copied = 0;
  
  try {
    // Count files in source that will be copied (applying filter if provided)
    const sourceFiles = await getAllFiles(source);
    if (filter) {
      // Filter function only receives src path, compute dest path to pass to filter
      copied = sourceFiles.filter(srcFile => {
        const relativePath = path.relative(source, srcFile);
        const destPath = path.join(destination, relativePath);
        return filter(srcFile, destPath);
      }).length;
    } else {
      copied = sourceFiles.length;
    }
    
    // Use fs.cp for recursive copy (Node 16.7+)
    await fs.cp(source, destination, { 
      recursive: true,
      preserveTimestamps: true,
      ...(filter && { filter }),
    });
    
    return { success: errors.length === 0, copied, errors };
  } catch (err: any) {
    // Handle specific error codes
    if (err.code === 'ENOENT') {
      errors.push(`Source directory not found: ${source}`);
    } else if (err.code === 'EACCES') {
      errors.push(`Permission denied: ${err.path}`);
    } else if (err.code === 'ENOSPC') {
      errors.push('Disk full - not enough space to complete backup');
    } else {
      errors.push(err.message);
    }
    return { success: false, copied, errors };
  }
}

/**
 * Check if a directory exists and has content
 */
async function directoryExistsAndHasContent(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Manual backup command - copies user data and project data to configured backup directory
 */
export async function backupCommand(): Promise<void> {
  console.log('\n💾 Tix-Kanban Manual Backup');
  console.log('===========================\n');
  
  // Get backup directory from settings
  const backupDir = await getBackupDirFromSettings();
  
  if (!backupDir) {
    console.log('⚠️  No backup directory configured.');
    console.log('\nTo configure a backup directory, run:');
    console.log('  tix setup');
    console.log('  (then set backup.backupDir in the tix-kanban settings)\n');
    console.log('Or manually add the following to ~/.tix-kanban/user-settings.json:');
    console.log('  {\n    "backup": {\n      "backupDir": "/path/to/your/backup/directory"\n    }\n  }\n');
    process.exit(0);
  }
  
  console.log(`📁 Backup directory: ${backupDir}\n`);
  
  // Verify backup directory is accessible
  try {
    await fs.access(backupDir);
  } catch {
    console.log(`Creating backup directory: ${backupDir}`);
    await fs.mkdir(backupDir, { recursive: true });
  }
  
  let success = true;
  let totalCopied = 0;
  
  // Load backup category preferences and build a filter for STORAGE_DIR
  const categories = await getBackupCategories();
  const disabledPaths = new Set<string>();
  for (const [category, enabled] of Object.entries(categories)) {
    if (!enabled) {
      for (const rel of (CATEGORY_PATHS[category] || [])) {
        disabledPaths.add(path.join(STORAGE_DIR, rel));
      }
    }
  }
  const categoryFilter = disabledPaths.size > 0
    ? (src: string) => !Array.from(disabledPaths).some(
        disabled => src === disabled || src.startsWith(disabled + path.sep)
      )
    : undefined;
  
  // Step 1: Copy ~/.tix-kanban to backupDir/.tix-kanban
  const userDataDest = path.join(backupDir, '.tix-kanban');
  const userDataExists = await directoryExistsAndHasContent(STORAGE_DIR);
  
  if (userDataExists) {
    const disabledCategories = Object.entries(categories)
      .filter(([, enabled]) => !enabled)
      .map(([cat]) => cat);
    console.log('📦 Backing up ~/.tix-kanban...');
    if (disabledCategories.length > 0) {
      console.log(`   ⏭️  Skipping disabled categories: ${disabledCategories.join(', ')}`);
    }
    const result = await copyDirectory(STORAGE_DIR, userDataDest, categoryFilter);
    
    if (result.success) {
      console.log(`   ✅ Copied ${result.copied} files to ${userDataDest}`);
      totalCopied += result.copied;
    } else {
      console.error(`   ❌ Failed: ${result.errors.join(', ')}`);
      success = false;
    }
  } else {
    console.log('📦 ~/.tix-kanban is empty or does not exist, skipping...');
  }
  
  // Step 2: Copy tix-kanban project to backupDir/tix-kanban
  const projectDest = path.join(backupDir, 'tix-kanban');
  const projectSource = TIX_KANBAN_PROJECT_DIR;
  const projectExists = existsSync(projectSource);
  
  if (projectExists) {
    console.log('📦 Backing up tix-kanban project...');
    const result = await copyDirectory(projectSource, projectDest);
    
    if (result.success) {
      console.log(`   ✅ Copied ${result.copied} files to ${projectDest}`);
      totalCopied += result.copied;
    } else {
      console.error(`   ❌ Failed: ${result.errors.join(', ')}`);
      success = false;
    }
  } else {
    console.log('📦 tix-kanban project not found, skipping...');
  }
  
  // Summary
  console.log('\n' + '='.repeat(40));
  if (success) {
    console.log(`✅ Backup complete! ${totalCopied} files copied.`);
    console.log(`   📍 Location: ${backupDir}`);
  } else {
    console.log('⚠️  Backup completed with errors.');
    console.log('   Please check the error messages above.');
    process.exit(1);
  }
}
