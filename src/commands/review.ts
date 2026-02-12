import chalk from 'chalk';
import inquirer from 'inquirer';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview } from '../lib/review-github';
import { reviewPR, checkClaudeCli, checkCodexCli, getAvailableProviders } from '../lib/review-ai';
import { extractChangedSymbols, findUsages, formatUsageContext, getRepoRoot } from '../lib/review-usage';
import { loadReviewSettings } from '../lib/review-config';
import type { Harshness, AIProvider, ReviewComment } from '../types';

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  BUG: chalk.red,
  SECURITY: chalk.magenta,
  SUGGESTION: chalk.yellow,
  NITPICK: chalk.gray,
};

const SEVERITY_ICONS: Record<string, string> = {
  BUG: '[BUG]',
  SECURITY: '[SEC]',
  SUGGESTION: '[SUG]',
  NITPICK: '[NIT]',
};

interface ReviewOptions {
  repo?: string;
  ai?: string;
  harshness?: string;
  dryRun?: boolean;
  batch?: boolean;
  fullContext?: boolean;
  usageContext?: boolean;
}

export async function reviewCommand(prNumberStr: string, options: ReviewOptions): Promise<void> {
  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    console.error(chalk.red('Invalid PR number'));
    process.exit(1);
  }

  // Load saved settings and merge with CLI flags (flags override)
  const saved = loadReviewSettings();

  const harshness: Harshness = (options.harshness as Harshness) || saved.harshness;
  if (!['chill', 'medium', 'pedantic'].includes(harshness)) {
    console.error(chalk.red('Invalid harshness level. Use: chill, medium, pedantic'));
    process.exit(1);
  }

  const fullContext = options.fullContext !== undefined ? options.fullContext : saved.fullContext;
  const usageContext = options.usageContext !== undefined ? options.usageContext : saved.usageContext;

  // Determine AI provider
  let ai: AIProvider;
  if (options.ai) {
    if (!['claude', 'codex'].includes(options.ai)) {
      console.error(chalk.red('Invalid AI provider. Use: claude, codex'));
      process.exit(1);
    }
    ai = options.ai as AIProvider;
  } else {
    ai = saved.ai;
  }

  // Verify chosen provider is available
  if (ai === 'claude' && !checkClaudeCli()) {
    console.error(chalk.red('\nClaude CLI not found.'));
    console.log(chalk.dim('Install it: npm install -g @anthropic-ai/claude-code'));
    console.log(chalk.dim('Then run: claude login'));
    process.exit(1);
  }
  if (ai === 'codex' && !checkCodexCli()) {
    console.error(chalk.red('\nCodex CLI not found.'));
    console.log(chalk.dim('Install it: npm install -g @openai/codex'));
    process.exit(1);
  }

  // If saved provider not available, try auto-detect
  if (!options.ai) {
    const available = getAvailableProviders();
    if (!available.includes(ai)) {
      if (available.length === 0) {
        console.error(chalk.red('\nNo AI CLI found.'));
        console.log(chalk.dim('Install one of:'));
        console.log(chalk.dim('  Claude: npm install -g @anthropic-ai/claude-code && claude login'));
        console.log(chalk.dim('  Codex:  npm install -g @openai/codex'));
        process.exit(1);
      }
      ai = available[0];
    }
  }

  const dryRun = options.dryRun || false;
  const batch = options.batch || false;
  const repo = options.repo;

  // Fetch PR details
  console.log(chalk.blue(`\nFetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  console.log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  console.log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  // Fetch diff
  console.log(chalk.blue(`\nFetching diff...`));
  const diff = getPRDiff(prNumber, repo);

  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Fetch full file contents if enabled
  let fileContents: Record<string, string> | undefined;
  if (fullContext) {
    console.log(chalk.blue(`\nFetching full file contents...`));
    const changedFiles = getChangedFiles(prNumber, repo);
    fileContents = {};
    for (const file of changedFiles) {
      if (file.endsWith('.lock') || (file.endsWith('.json') && file.includes('package-lock'))) {
        continue;
      }
      const content = getFileContent(prNumber, file, repo);
      if (content) {
        if (content.length > 300000) {
          console.log(chalk.yellow(`   skip ${file} (too large: ${Math.round(content.length / 1024)}KB)`));
        } else {
          fileContents[file] = content;
          console.log(chalk.gray(`   + ${file} (${Math.round(content.length / 1024)}KB)`));
        }
      }
    }
  }

  // Extract usage context if enabled
  let usageContextStr = '';
  if (usageContext) {
    console.log(chalk.blue(`\nFinding symbol usages...`));
    const symbols = extractChangedSymbols(diff);
    console.log(chalk.gray(`   Found ${symbols.length} changed symbol(s): ${symbols.map(s => s.name).join(', ') || '(none)'}`));

    if (symbols.length > 0) {
      const repoRoot = getRepoRoot();
      const usages = findUsages(symbols, repoRoot, {
        maxUsagesPerSymbol: 5,
        contextLines: 3
      });

      if (usages.length > 0) {
        console.log(chalk.gray(`   Found ${usages.length} usage(s) across ${new Set(usages.map(u => u.file)).size} file(s)`));
        usageContextStr = formatUsageContext(usages);
      } else {
        console.log(chalk.gray(`   No external usages found`));
      }
    }
  }

  // Review with AI
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  const contextModes = [harshness + ' mode'];
  if (fullContext) contextModes.push('full context');
  if (usageContext && usageContextStr) contextModes.push('usage context');
  const modeLabel = contextModes.join(' + ');
  console.log(chalk.blue(`\nReviewing with ${aiLabel} (${modeLabel})...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents, usageContextStr);

  console.log(chalk.gray(`\n${result.summary}\n`));

  if (result.comments.length === 0) {
    console.log(chalk.green('LGTM - no issues found'));
    return;
  }

  console.log(chalk.white(`Found ${result.comments.length} potential comment(s):\n`));

  // Interactive selection
  const selectedComments: ReviewComment[] = [];

  for (let i = 0; i < result.comments.length; i++) {
    const comment = result.comments[i];
    const severityColor = SEVERITY_COLORS[comment.severity] || chalk.white;
    const severityIcon = SEVERITY_ICONS[comment.severity] || '-';

    console.log(chalk.white('-'.repeat(60)));
    console.log(
      chalk.white(`[${i + 1}/${result.comments.length}] `) +
      severityIcon + ' ' +
      severityColor(comment.severity) +
      chalk.gray(` | ${comment.file}:${comment.line}`)
    );
    console.log(chalk.white('-'.repeat(60)));
    console.log(chalk.bold(comment.title));
    console.log(chalk.white(comment.body));
    if (comment.suggestion) {
      console.log(chalk.green('\nSuggested fix:'));
      console.log(chalk.gray(comment.suggestion));
    }
    console.log();

    if (dryRun) {
      console.log(chalk.gray('(dry-run mode - not posting)\n'));
      continue;
    }

    if (batch) {
      selectedComments.push(comment);
      console.log(chalk.green('+ Queued\n'));
      continue;
    }

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Action',
      choices: [
        { name: 'Add', value: 'add' },
        { name: 'Skip', value: 'skip' },
        { name: 'Quit', value: 'quit' },
      ],
    }]);

    if (action === 'quit') {
      console.log(chalk.yellow('\nQuitting review.'));
      break;
    }

    if (action === 'add') {
      selectedComments.push(comment);
      console.log(chalk.green('+ Queued\n'));
    } else {
      console.log(chalk.gray('- Skipped\n'));
    }
  }

  // Summary
  console.log(chalk.white('='.repeat(60)));
  console.log(chalk.white(`Summary: ${selectedComments.length} to post, ${result.comments.length - selectedComments.length} skipped`));
  console.log(chalk.white('='.repeat(60)));

  if (selectedComments.length === 0) {
    console.log(chalk.gray('\nNo comments to post.'));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow('\n(dry-run mode - skipping post)'));
    return;
  }

  // Confirm and post
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `Post ${selectedComments.length} comment(s) to PR #${prNumber}?`,
    default: true,
  }]);

  if (!confirm) {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }

  console.log(chalk.blue('\nPosting review...'));

  const formattedComments = selectedComments.map(c => {
    let body = `**${c.title}**\n\n${c.body}`;
    if (c.suggestion) {
      body += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${c.suggestion}\n\`\`\``;
    }
    return {
      file: c.file,
      line: c.line,
      body,
    };
  });

  submitReview(prNumber, formattedComments, repo);

  console.log(chalk.green(`\nPosted ${selectedComments.length} comment(s)`));
}
