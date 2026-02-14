import chalk from 'chalk';
import inquirer from 'inquirer';
import { cronManager } from './cron';

export async function cronSetupCommand() {
  console.log(chalk.bold.blue('\n🤖 tix-kanban Cron Setup\n'));
  
  console.log('This will set up automated kanban task processing using cron jobs.');
  console.log('The system will periodically check for tasks assigned to AI and process them.\n');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'interval',
      message: 'How often should the worker check for tasks?',
      choices: [
        { name: 'Every 10 minutes', value: '*/10 * * * *' },
        { name: 'Every 20 minutes', value: '*/20 * * * *' },
        { name: 'Every 30 minutes (recommended)', value: '*/30 * * * *' },
        { name: 'Every hour', value: '0 * * * *' },
        { name: 'Custom expression', value: 'custom' }
      ],
      default: '*/30 * * * *'
    },
    {
      type: 'input',
      name: 'customExpression',
      message: 'Enter custom cron expression:',
      when: (answers) => answers.interval === 'custom',
      validate: (input) => {
        const cron = require('node-cron');
        return cron.validate(input) || 'Invalid cron expression';
      }
    },
    {
      type: 'number',
      name: 'maxConcurrent',
      message: 'Maximum concurrent sessions:',
      default: 1,
      validate: (input) => input > 0 && input <= 5
    },
    {
      type: 'confirm',
      name: 'startNow',
      message: 'Start the cron daemon now?',
      default: true
    }
  ]);

  const expression = answers.interval === 'custom' ? answers.customExpression : answers.interval;

  try {
    // Add the kanban worker job
    const jobId = await cronManager.addJob(
      'Kanban Worker',
      expression,
      'kanban-worker',
      {
        maxConcurrent: answers.maxConcurrent,
        enabled: true
      }
    );

    console.log(chalk.green(`\n✅ Created kanban worker job (${jobId})`));
    console.log(`   Expression: ${expression}`);
    console.log(`   Max concurrent: ${answers.maxConcurrent}`);

    if (answers.startNow) {
      await cronManager.startAll();
      console.log(chalk.green('\n🚀 Cron daemon started!'));
      console.log('\nUseful commands:');
      console.log('  tix cron list           - View all cron jobs');
      console.log('  tix cron runs <job-id>  - View job execution history');
      console.log('  tix cron trigger <job-id> - Run job immediately');
      console.log('  tix cron stop           - Stop the cron daemon');
    } else {
      console.log(chalk.yellow('\n⚠️ Cron daemon not started. Run `tix cron start` to begin.'));
    }

    console.log('\n📁 Configuration and logs stored in ~/.tix-kanban/');

  } catch (error: any) {
    console.error(chalk.red(`\n❌ Setup failed: ${error.message}`));
    process.exit(1);
  }
}