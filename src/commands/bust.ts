import chalk from 'chalk';
import { execSync } from 'child_process';
import { parsePRUrl } from '../lib/github';
import { loadConfig } from '../lib/config';

interface BustOptions {
  dryRun?: boolean;
  verbose?: boolean;
  ai?: string;
  authors?: string;
}

export async function bustCommand(prArg: string, options: BustOptions): Promise<void> {
  const config = loadConfig();

  console.log(chalk.bold.cyan('\n💥 Bugbot Buster\n'));

  // Normalize the PR argument
  let prRef = prArg;

  // If it's a full URL, validate it
  if (prArg.startsWith('http')) {
    const parsed = parsePRUrl(prArg);
    if (!parsed) {
      console.error(chalk.red('Invalid GitHub PR URL.'));
      console.log(chalk.dim('Expected: https://github.com/owner/repo/pull/123'));
      process.exit(1);
    }
    prRef = prArg;
  } else if (prArg.includes('#')) {
    // Format: owner/repo#123 or repo#123
    const [repoRef, numStr] = prArg.split('#');
    const num = parseInt(numStr, 10);
    if (isNaN(num)) {
      console.error(chalk.red('Invalid PR reference. Expected: owner/repo#123 or a PR URL.'));
      process.exit(1);
    }
    const fullRepo = repoRef.includes('/') ? repoRef : `${config.githubOrg}/${repoRef}`;
    prRef = `https://github.com/${fullRepo}/pull/${num}`;
  } else if (/^\d+$/.test(prArg)) {
    // Just a number — need more context
    console.error(chalk.red('PR number alone is ambiguous. Provide a full URL or owner/repo#number.'));
    process.exit(1);
  }

  // Build command
  const args: string[] = ['npx', 'bugbot-buster', '--pr', prRef];

  args.push('--authors', options.authors || 'cursor');
  args.push('--ai', options.ai || 'codex');

  if (options.dryRun) args.push('--dry-run');
  if (options.verbose) args.push('--verbose');

  const cmd = args.join(' ');
  console.log(chalk.dim(`Running: ${cmd}\n`));

  try {
    execSync(cmd, {
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err: any) {
    if (err.status === 127 || (err.message && err.message.includes('not found'))) {
      console.error(chalk.red('\n⚠ bugbot-buster not found.\n'));
      console.log(chalk.bold('Install it:'));
      console.log(chalk.dim('  npm install -g bugbot-buster'));
      console.log(chalk.dim('  # or'));
      console.log(chalk.dim('  npx bugbot-buster --help'));
      console.log('');
    } else {
      // Command ran but exited with an error — output was already printed
      process.exit(err.status || 1);
    }
  }
}
