import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadReviewSettings, saveReviewSettings, getDefaults } from '../lib/review-config';
import type { ReviewSettings, AIProvider, Harshness } from '../types';

export async function reviewConfigCommand(): Promise<void> {
  const settings = loadReviewSettings();
  const defaults = getDefaults();

  console.log(chalk.blue('\nReview Settings'));
  console.log(chalk.white('-'.repeat(40)));
  console.log(`  AI provider:    ${chalk.white(settings.ai)}`);
  console.log(`  Harshness:      ${chalk.white(settings.harshness)}`);
  console.log(`  Full context:   ${chalk.white(settings.fullContext ? 'on' : 'off')}`);
  console.log(`  Usage context:  ${chalk.white(settings.usageContext ? 'on' : 'off')}`);
  console.log(chalk.white('-'.repeat(40)));
  console.log();

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { name: 'Edit settings', value: 'edit' },
      { name: 'Reset to defaults', value: 'reset' },
      { name: 'Exit', value: 'exit' },
    ],
  }]);

  if (action === 'exit') {
    return;
  }

  if (action === 'reset') {
    saveReviewSettings(defaults);
    console.log(chalk.green('Settings reset to defaults.'));
    return;
  }

  // Edit settings interactively
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'ai',
      message: 'AI provider',
      choices: [
        { name: 'Claude', value: 'claude' },
        { name: 'Codex', value: 'codex' },
      ],
      default: settings.ai,
    },
    {
      type: 'list',
      name: 'harshness',
      message: 'Harshness level',
      choices: [
        { name: 'Chill — only definite bugs and security issues', value: 'chill' },
        { name: 'Medium — bugs, missing checks, error-prone patterns', value: 'medium' },
        { name: 'Pedantic — thorough review including style and suggestions', value: 'pedantic' },
      ],
      default: settings.harshness,
    },
    {
      type: 'confirm',
      name: 'fullContext',
      message: 'Enable full file context (sends complete file contents for pattern analysis)?',
      default: settings.fullContext,
    },
    {
      type: 'confirm',
      name: 'usageContext',
      message: 'Enable usage context (finds callers of changed symbols)?',
      default: settings.usageContext,
    },
  ]);

  const newSettings: ReviewSettings = {
    ai: answers.ai as AIProvider,
    harshness: answers.harshness as Harshness,
    fullContext: answers.fullContext,
    usageContext: answers.usageContext,
  };

  saveReviewSettings(newSettings);
  console.log(chalk.green('\nSettings saved.'));
}
