import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import inquirer from 'inquirer';

const execAsync = promisify(execCallback);

const STORAGE_DIR = path.join(os.homedir(), '.tix-kanban');

interface RestoreOptions {
  backupDir?: string;
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
