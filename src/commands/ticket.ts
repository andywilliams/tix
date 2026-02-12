import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig, extractNotionId, hasNotionApiConfig } from '../lib/config';
import { createNotionClient, getTicketDetail } from '../lib/notion';
import { getPRInfo, formatPRRef, checkGhCli, searchPRsByTicketId } from '../lib/github';
import { loadSyncedTickets, loadTicketDetail, findTicketByIdOrUrl } from '../lib/ticket-store';

function stateIcon(state: string): string {
  switch (state) {
    case 'open': return chalk.green('● open');
    case 'merged': return chalk.magenta('● merged');
    case 'closed': return chalk.red('● closed');
    default: return chalk.dim('● unknown');
  }
}

function checksIcon(checks: string): string {
  switch (checks) {
    case 'pass': return chalk.green('✓ passing');
    case 'fail': return chalk.red('✗ failing');
    case 'pending': return chalk.yellow('◐ pending');
    case 'none': return chalk.dim('— none');
    default: return chalk.dim('— unknown');
  }
}

function reviewIcon(reviews: string): string {
  switch (reviews) {
    case 'approved': return chalk.green('✓ approved');
    case 'changes_requested': return chalk.red('✗ changes requested');
    case 'pending': return chalk.yellow('◐ review pending');
    default: return chalk.dim('— unknown');
  }
}

export async function ticketCommand(notionUrlOrId: string): Promise<void> {
  const config = loadConfig();

  console.log(chalk.bold.cyan('\n🎫 Ticket Details\n'));

  if (!hasNotionApiConfig(config)) {
    // Sync mode: look up in cache
    const tickets = loadSyncedTickets();
    const cached = findTicketByIdOrUrl(notionUrlOrId, tickets);

    if (!cached) {
      console.error(chalk.red(`Ticket not found in cache: ${notionUrlOrId}`));
      console.log(chalk.dim('Run `tix sync` to refresh cached tickets.'));
      process.exit(1);
    }

    // Check for detailed cache
    const detail = loadTicketDetail(cached.id);

    console.log(chalk.bold.white(cached.title));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(`${chalk.bold('Status:')}     ${cached.status}`);
    console.log(`${chalk.bold('Priority:')}   ${cached.priority}`);
    console.log(`${chalk.bold('Updated:')}    ${cached.lastUpdated}`);
    if (cached.url) {
      console.log(`${chalk.bold('Notion:')}     ${chalk.underline.blue(cached.url)}`);
    }

    // Search GitHub for PRs if none cached
    let ghLinks = cached.githubLinks || [];
    if (ghLinks.length === 0 && cached.ticketNumber && config.githubOrg) {
      process.stdout.write(chalk.dim('Searching GitHub for PRs...\n'));
      ghLinks = searchPRsByTicketId(config.githubOrg, cached.ticketNumber);
    }

    if (ghLinks.length > 0) {
      const prLinks = ghLinks.filter(l => l.includes('/pull/'));
      const otherLinks = ghLinks.filter(l => !l.includes('/pull/'));

      const hasGh = checkGhCli();

      if (prLinks.length > 0 && hasGh) {
        console.log(chalk.dim('\n─── Pull Requests ───'));

        const prTable = new Table({
          head: [
            chalk.bold('PR'),
            chalk.bold('Title'),
            chalk.bold('State'),
            chalk.bold('Checks'),
            chalk.bold('Reviews'),
          ],
          colWidths: [25, 30, 14, 14, 20],
          wordWrap: true,
          style: { head: [], border: ['dim'] },
        });

        for (const prUrl of prLinks) {
          const info = await getPRInfo(prUrl);
          if (info) {
            prTable.push([
              formatPRRef(prUrl),
              info.title.length > 27 ? info.title.slice(0, 24) + '...' : info.title,
              stateIcon(info.state),
              checksIcon(info.checks),
              reviewIcon(info.reviews),
            ]);
          }
        }

        console.log(prTable.toString());
      } else {
        console.log(chalk.dim('\n─── GitHub Links ───'));
        for (const link of ghLinks) {
          console.log(`  ${chalk.underline.blue(link)}`);
        }
      }

      if (otherLinks.length > 0) {
        console.log(chalk.bold('\nOther Links:'));
        for (const link of otherLinks) {
          console.log(`  ${chalk.underline.blue(link)}`);
        }
      }
    } else {
      console.log(chalk.dim('\nNo GitHub PRs found.'));
    }

    console.log('');
    return;
  }

  const notion = createNotionClient(config);

  let pageId: string;
  try {
    pageId = extractNotionId(notionUrlOrId);
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  // Fetch ticket
  let detail;
  try {
    detail = await getTicketDetail(notion, pageId);
  } catch (err: any) {
    console.error(chalk.red(`Failed to fetch ticket: ${err.message}`));
    process.exit(1);
  }

  // Header
  console.log(chalk.bold.white(detail.title));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`${chalk.bold('Status:')}     ${detail.status}`);
  console.log(`${chalk.bold('Priority:')}   ${detail.priority}`);
  console.log(`${chalk.bold('Assignee:')}   ${detail.assignee}`);
  console.log(`${chalk.bold('Updated:')}    ${detail.lastUpdated}`);
  console.log(`${chalk.bold('Notion:')}     ${chalk.underline.blue(detail.url)}`);

  // Show all properties
  const propKeys = Object.keys(detail.properties).filter(
    k => !['Status', 'Priority', 'Assigned to', 'Assignee', 'Name', 'Title'].includes(k)
  );
  if (propKeys.length > 0) {
    console.log(chalk.dim('\n─── Properties ───'));
    for (const key of propKeys) {
      const val = detail.properties[key];
      if (val && val !== '—') {
        console.log(`${chalk.bold(key + ':')}  ${val}`);
      }
    }
  }

  // GitHub links
  if (detail.githubLinks.length > 0) {
    console.log(chalk.dim('\n─── GitHub Links ───'));

    const hasGh = checkGhCli();
    if (!hasGh) {
      console.log(chalk.yellow('⚠ `gh` CLI not found or not authenticated. Install with: brew install gh'));
    }

    // Filter PR links
    const prLinks = detail.githubLinks.filter(l => l.includes('/pull/'));
    const otherLinks = detail.githubLinks.filter(l => !l.includes('/pull/'));

    if (prLinks.length > 0 && hasGh) {
      console.log(chalk.bold('\nPull Requests:'));

      const prTable = new Table({
        head: [
          chalk.bold('PR'),
          chalk.bold('Title'),
          chalk.bold('State'),
          chalk.bold('Checks'),
          chalk.bold('Reviews'),
        ],
        colWidths: [25, 30, 14, 14, 20],
        wordWrap: true,
        style: { head: [], border: ['dim'] },
      });

      for (const prUrl of prLinks) {
        const info = await getPRInfo(prUrl);
        if (info) {
          prTable.push([
            formatPRRef(prUrl),
            info.title.length > 27 ? info.title.slice(0, 24) + '...' : info.title,
            stateIcon(info.state),
            checksIcon(info.checks),
            reviewIcon(info.reviews),
          ]);
        }
      }

      console.log(prTable.toString());
    } else if (prLinks.length > 0) {
      for (const link of prLinks) {
        console.log(`  ${chalk.underline.blue(link)}`);
      }
    }

    if (otherLinks.length > 0) {
      console.log(chalk.bold('\nOther Links:'));
      for (const link of otherLinks) {
        console.log(`  ${chalk.underline.blue(link)}`);
      }
    }
  } else {
    console.log(chalk.dim('\nNo GitHub links found in ticket content.'));
  }

  console.log('');
}
