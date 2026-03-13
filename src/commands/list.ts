import { Client } from '@notionhq/client';
import { loadConfig } from '../lib/config';
import { createNotionClient, extractGitHubLinksFromText, extractPropertyValue, findProperty, findTitleProperty } from '../lib/notion';

interface ListOptions {
  json?: boolean;
  limit?: string;
  since?: string;
  status?: string;
  assignee?: string;
  cursor?: string;
}

interface ForgeTicket {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  labels: string[];
  url: string;
  githubLinks: string[];
  lastUpdated: string;
}

interface QueryResult {
  tickets: ForgeTicket[];
  cursor: string | null;
  hasMore: boolean;
}

export async function listCommand(options: ListOptions = {}): Promise<void> {
  const config = loadConfig();

  // Check for Notion API key
  if (!config.notionApiKey) {
    const error = { error: "Notion API key not configured. Run 'tix setup' to configure.", code: "auth-failure" };
    console.error(JSON.stringify(error));
    process.exit(2);
  }

  if (!config.notionDatabaseId) {
    const error = { error: "Notion database ID not configured. Run 'tix setup' to configure.", code: "config-missing" };
    console.error(JSON.stringify(error));
    process.exit(1);
  }

  const notion = createNotionClient(config);

  try {
    const result = await queryTickets(notion, config, options);

    if (options.json) {
      // Machine-readable JSON output
      console.log(JSON.stringify(result));
    } else {
      // Human-readable output
      if (result.tickets.length === 0) {
        console.log('No tickets found.');
        return;
      }
      console.log(`Found ${result.tickets.length} ticket(s):\n`);
      for (const t of result.tickets) {
        const statusStr = t.status ? `[${t.status}]` : '';
        const ticketNum = t.ticketNumber ? `${t.ticketNumber} ` : '';
        console.log(`  ${ticketNum}${t.title} ${statusStr}`);
      }
    }
  } catch (err: any) {
    const errorMessage = err.message || String(err);
    
    // Check for auth errors
    if (errorMessage.includes('Unauthorized') || errorMessage.includes('401') || 
        errorMessage.toLowerCase().includes('invalid api key') || 
        errorMessage.toLowerCase().includes('unauthorized')) {
      const error = { error: "Invalid or expired Notion API key", code: "auth-failure" };
      console.error(JSON.stringify(error));
      process.exit(2);
    }
    
    // Check for timeout
    if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      const error = { error: "Request timed out", code: "timeout" };
      console.error(JSON.stringify(error));
      process.exit(3);
    }

    // General error
    const error = { error: errorMessage, code: "unknown" };
    console.error(JSON.stringify(error));
    process.exit(1);
  }
}

async function queryTickets(
  notion: Client,
  config: any,
  options: ListOptions
): Promise<QueryResult> {
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const cursor = options.cursor;

  // Build filter
  const filter: any = { and: [] };

  // Status filter
  if (options.status) {
    filter.and.push({
      property: 'Status',
      status: { equals: options.status },
    });
  }

  // Since filter (last edited time)
  if (options.since) {
    filter.and.push({
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: options.since },
    });
  }

  // Assignee filter
  if (options.assignee) {
    filter.and.push({
      or: [
        { property: 'Assigned to', people: { contains: options.assignee } },
        { property: 'Assignee', people: { contains: options.assignee } },
        { property: 'Assigned', people: { contains: options.assignee } },
      ],
    });
  }

  const filterObj = filter.and.length > 0 ? filter : undefined;

  let response: any;
  try {
    response = await notion.databases.query({
      database_id: config.notionDatabaseId,
      page_size: Math.min(limit, 100),
      start_cursor: cursor,
      filter: filterObj,
    });
  } catch (err: any) {
    // If filter fails (e.g., property doesn't exist), try without filter
    if (err.message?.includes('property') || err.message?.includes('does not exist')) {
      response = await notion.databases.query({
        database_id: config.notionDatabaseId,
        page_size: Math.min(limit, 100),
        start_cursor: cursor,
      });
    } else {
      throw err;
    }
  }

  const results = response.results;

  const tickets: ForgeTicket[] = [];

  for (const page of results) {
    if (page.object !== 'page') continue;

    const props = (page as any).properties || {};
    const pageId = (page as any).id;
    
    const titleProp = findTitleProperty(props);
    const title = extractPropertyValue(props[titleProp]);
    const status = findProperty(props, ['Status', 'State', 'Stage']);
    const priority = findProperty(props, ['Priority', 'Importance', 'Urgency', 'P']);
    const assignee = findProperty(props, ['Assigned to', 'Assignee', 'Assigned', 'Owner', 'Person']);
    const ticketNumber = findProperty(props, ['New ID', 'ID', 'Ticket ID', 'Ticket Number']);
    const lastUpdated = (page as any).last_edited_time || '';
    
    // Extract labels from multi-select
    const labelsProp = props['Labels'] || props['Tags'] || props['label'];
    const labels: string[] = [];
    if (labelsProp?.type === 'multi_select') {
      for (const s of labelsProp.multi_select) {
        labels.push(s.name);
      }
    }

    const url = (page as any).url || `https://notion.so/${pageId.replace(/-/g, '')}`;

    // Scan for GitHub links in properties
    const githubLinks: string[] = [];
    for (const [, prop] of Object.entries(props)) {
      const val = extractPropertyValue(prop);
      if (typeof val === 'string') {
        const links = extractGitHubLinksFromText(val);
        githubLinks.push(...links);
      }
    }

    // Format lastUpdated to YYYY-MM-DD
    const formattedDate = lastUpdated ? new Date(lastUpdated).toISOString().split('T')[0] : '';

    tickets.push({
      id: pageId,
      ticketNumber: ticketNumber || '',
      title: title || '(untitled)',
      status: status || '',
      priority: priority || '',
      assignee: assignee || '',
      labels,
      url,
      githubLinks: [...new Set(githubLinks)],
      lastUpdated: formattedDate,
    });
  }

  return {
    tickets,
    cursor: response.next_cursor || null,
    hasMore: response.has_more || false,
  };
}


