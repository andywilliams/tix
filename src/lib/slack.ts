import chalk from 'chalk';
import { execSync } from 'child_process';

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: any[];
  fields?: any[];
}

interface SlackMessage {
  blocks: SlackBlock[];
}

interface StandupEntry {
  date: string;
  yesterday: string[];
  today: string[];
  blockers: string[];
  commits: Array<{
    repo: string;
    hash: string;
    message: string;
    author: string;
    date: string;
  }>;
  prs: Array<{
    repo: string;
    number: number;
    title: string;
    action: string;
    url: string;
    date: string;
  }>;
  issues: Array<{
    repo: string;
    number: number;
    title: string;
    action: string;
    url: string;
    date: string;
  }>;
}

/**
 * Format standup entry as Slack blocks
 */
export function formatStandupForSlack(entry: StandupEntry, userName: string): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📋 ${userName}'s Standup - ${entry.date}`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*✅ Yesterday:*"
      }
    }
  ];

  // Add yesterday items
  if (entry.yesterday.length > 0) {
    const yesterdayText = entry.yesterday.map(item => `• ${item}`).join('\n');
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: yesterdayText
      }
    });
  }

  // Add divider
  blocks.push({ type: "divider" });

  // Add today section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*🎯 Today:*"
    }
  });

  if (entry.today.length > 0) {
    const todayText = entry.today.map(item => `• ${item}`).join('\n');
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: todayText
      }
    });
  }

  // Add divider
  blocks.push({ type: "divider" });

  // Add blockers section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*🚫 Blockers:*"
    }
  });

  if (entry.blockers.length > 0) {
    const blockersText = entry.blockers.map(item => `• ${item}`).join('\n');
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: blockersText
      }
    });
  }

  // Add activity summary if there's data
  if (entry.commits.length > 0 || entry.prs.length > 0 || entry.issues.length > 0) {
    blocks.push({ type: "divider" });
    
    const activityParts = [];
    if (entry.commits.length > 0) activityParts.push(`${entry.commits.length} commits`);
    if (entry.prs.length > 0) activityParts.push(`${entry.prs.length} PR activities`);
    if (entry.issues.length > 0) activityParts.push(`${entry.issues.length} issues closed`);
    
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📊 Activity summary: ${activityParts.join(', ')}`
        }
      ]
    });
  }

  return { blocks };
}

/**
 * Post standup to Slack webhook
 */
export async function postToSlack(webhookUrl: string, standupEntry: StandupEntry, userName: string): Promise<void> {
  try {
    const message = formatStandupForSlack(standupEntry, userName);
    const payload = JSON.stringify(message);
    
    // Use curl to post to Slack webhook
    const cmd = `curl -X POST -H "Content-type: application/json" --data '${payload.replace(/'/g, "'\"'\"'")}' "${webhookUrl}"`;
    
    const result = execSync(cmd, { 
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    if (result.trim() === 'ok') {
      console.log(chalk.green('✅ Standup posted to Slack!'));
    } else {
      console.log(chalk.yellow(`⚠️ Slack response: ${result}`));
    }
    
  } catch (err: any) {
    throw new Error(`Failed to post to Slack: ${err.message}`);
  }
}

/**
 * Validate Slack webhook URL
 */
export function validateSlackWebhook(url: string): boolean {
  return url.startsWith('https://hooks.slack.com/') && url.includes('/services/');
}