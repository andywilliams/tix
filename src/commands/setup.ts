import inquirer from 'inquirer';
import chalk from 'chalk';
import { saveConfig, getConfigPath, configExists, extractNotionId } from '../lib/config';
import { EqConfig } from '../types';

export async function setupCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n🔧 eq setup\n'));
  console.log('Configure your Equals Money developer environment.\n');

  if (configExists()) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Config already exists. Overwrite?',
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.yellow('Setup cancelled.'));
      return;
    }
  }

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'notionApiKey',
      message: 'Notion API key (integration token):',
      mask: '*',
      validate: (input: string) =>
        input.startsWith('secret_') || input.startsWith('ntn_')
          ? true
          : 'Notion API keys start with "secret_" or "ntn_"',
    },
    {
      type: 'input',
      name: 'notionDatabaseId',
      message: 'Notion database ID (or full URL):',
      validate: (input: string) => {
        try {
          extractNotionId(input);
          return true;
        } catch {
          return 'Could not extract a valid Notion ID. Provide a 32-char hex ID or Notion URL.';
        }
      },
    },
    {
      type: 'input',
      name: 'userName',
      message: 'Your name (as it appears in Notion "Assigned to"):',
      validate: (input: string) =>
        input.trim().length > 0 ? true : 'Name is required',
    },
    {
      type: 'input',
      name: 'githubOrg',
      message: 'Default GitHub org:',
      default: 'equals-money',
    },
  ]);

  const config: EqConfig = {
    notionApiKey: answers.notionApiKey.trim(),
    notionDatabaseId: extractNotionId(answers.notionDatabaseId),
    userName: answers.userName.trim(),
    githubOrg: answers.githubOrg.trim(),
  };

  saveConfig(config);

  console.log(chalk.green(`\n✅ Config saved to ${getConfigPath()}`));
  console.log(chalk.dim('\nYou can now run:'));
  console.log(chalk.dim('  eq status    — view your tickets'));
  console.log(chalk.dim('  eq ticket    — deep-dive a ticket'));
  console.log(chalk.dim('  eq inspect   — inspect Notion structure'));
  console.log(chalk.dim('  eq bust      — run bugbot-buster on a PR\n'));
}
