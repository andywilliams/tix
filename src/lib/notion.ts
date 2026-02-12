import { Client } from '@notionhq/client';
import { EqConfig, TicketSummary, TicketDetail } from '../types';

export function createNotionClient(config: EqConfig): Client {
  return new Client({ auth: config.notionApiKey });
}

/**
 * Extract a readable value from a Notion property.
 */
function extractPropertyValue(prop: any): string {
  if (!prop) return '';

  switch (prop.type) {
    case 'title':
      return prop.title?.map((t: any) => t.plain_text).join('') || '';
    case 'rich_text':
      return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return prop.multi_select?.map((s: any) => s.name).join(', ') || '';
    case 'status':
      return prop.status?.name || '';
    case 'number':
      return prop.number?.toString() || '';
    case 'checkbox':
      return prop.checkbox ? '✓' : '✗';
    case 'date':
      return prop.date?.start || '';
    case 'people':
      return prop.people?.map((p: any) => p.name || p.id).join(', ') || '';
    case 'url':
      return prop.url || '';
    case 'email':
      return prop.email || '';
    case 'phone_number':
      return prop.phone_number || '';
    case 'relation':
      return prop.relation?.map((r: any) => r.id).join(', ') || '';
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || '';
      if (prop.formula?.type === 'number') return prop.formula.number?.toString() || '';
      if (prop.formula?.type === 'boolean') return prop.formula.boolean ? '✓' : '✗';
      if (prop.formula?.type === 'date') return prop.formula.date?.start || '';
      return '';
    case 'rollup':
      return JSON.stringify(prop.rollup);
    case 'created_time':
      return prop.created_time || '';
    case 'last_edited_time':
      return prop.last_edited_time || '';
    case 'created_by':
      return prop.created_by?.name || '';
    case 'last_edited_by':
      return prop.last_edited_by?.name || '';
    default:
      return JSON.stringify(prop);
  }
}

/**
 * Find the title property name in a set of properties.
 */
function findTitleProperty(properties: Record<string, any>): string {
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === 'title') return name;
  }
  return 'Name'; // fallback
}

/**
 * Try to find a property by common names (case-insensitive).
 */
function findProperty(properties: Record<string, any>, candidates: string[]): string {
  const keys = Object.keys(properties);
  for (const candidate of candidates) {
    const found = keys.find(k => k.toLowerCase() === candidate.toLowerCase());
    if (found) return extractPropertyValue(properties[found]);
  }
  return '';
}

/**
 * Query tickets assigned to the configured user.
 */
export async function queryMyTickets(
  notion: Client,
  config: EqConfig
): Promise<TicketSummary[]> {
  // We need to search by name since we may not have the user's Notion ID.
  // First, try a simple query without filter, then filter client-side by name.
  // This is more robust since "Assigned to" property name may vary.
  
  let results: any[] = [];
  
  try {
    // Try querying with a text-based filter on common assignment properties
    const response = await notion.databases.query({
      database_id: config.notionDatabaseId!,
      page_size: 100,
    });
    results = response.results;
  } catch (err: any) {
    throw new Error(`Failed to query Notion database: ${err.message}`);
  }

  // Filter client-side by assigned user name
  const tickets: TicketSummary[] = [];
  const userName = config.userName.toLowerCase();

  for (const page of results) {
    if (page.object !== 'page') continue;

    const props = (page as any).properties || {};
    
    // Check if assigned to matches
    const assignee = findProperty(props, [
      'Assigned to', 'Assignee', 'Assigned', 'Owner', 'Person', 'People'
    ]).toLowerCase();

    if (assignee && !assignee.includes(userName)) continue;
    // If no assignee property found, include the ticket (better to show too many than too few)

    const titleProp = findTitleProperty(props);
    const title = extractPropertyValue(props[titleProp]);
    const status = findProperty(props, ['Status', 'State', 'Stage']);
    const priority = findProperty(props, ['Priority', 'Importance', 'Urgency', 'P']);
    const lastUpdated = (page as any).last_edited_time || '';

    const pageId = (page as any).id;
    const url = (page as any).url || `https://notion.so/${pageId.replace(/-/g, '')}`;

    // Scan page blocks for GitHub links
    let githubLinks: string[] = [];
    try {
      const blocks = await notion.blocks.children.list({ block_id: pageId });
      for (const block of blocks.results) {
        const links = extractGitHubLinksFromBlock(block);
        githubLinks.push(...links);
      }
    } catch {
      // Page content might not be accessible
    }

    // Also check properties for GitHub URLs
    for (const [, prop] of Object.entries(props)) {
      const val = extractPropertyValue(prop);
      if (typeof val === 'string') {
        const links = extractGitHubLinksFromText(val);
        githubLinks.push(...links);
      }
    }

    githubLinks = [...new Set(githubLinks)];

    tickets.push({
      id: pageId,
      title: title || '(untitled)',
      status: status || '—',
      priority: priority || '—',
      lastUpdated: lastUpdated ? new Date(lastUpdated).toLocaleDateString() : '—',
      url,
      githubLinks,
    });
  }

  return tickets;
}

/**
 * Fetch full details for a single ticket/page.
 */
export async function getTicketDetail(
  notion: Client,
  pageId: string
): Promise<TicketDetail> {
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const props = page.properties || {};

  const titleProp = findTitleProperty(props);
  const title = extractPropertyValue(props[titleProp]);
  const status = findProperty(props, ['Status', 'State', 'Stage']);
  const priority = findProperty(props, ['Priority', 'Importance', 'Urgency', 'P']);
  const assignee = findProperty(props, [
    'Assigned to', 'Assignee', 'Assigned', 'Owner', 'Person', 'People'
  ]);
  const lastUpdated = page.last_edited_time || '';
  const url = page.url || `https://notion.so/${pageId.replace(/-/g, '')}`;

  // Build a clean properties map
  const cleanProps: Record<string, any> = {};
  for (const [name, prop] of Object.entries(props)) {
    cleanProps[name] = extractPropertyValue(prop);
  }

  // Fetch page content blocks to find GitHub links
  const githubLinks: string[] = [];
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    for (const block of blocks.results) {
      const links = extractGitHubLinksFromBlock(block);
      githubLinks.push(...links);
    }
  } catch {
    // Page content might not be accessible
  }

  // Also check properties for GitHub URLs
  for (const value of Object.values(cleanProps)) {
    if (typeof value === 'string') {
      const links = extractGitHubLinksFromText(value);
      githubLinks.push(...links);
    }
  }

  // Deduplicate
  const uniqueLinks = [...new Set(githubLinks)];

  return {
    id: pageId,
    title: title || '(untitled)',
    status: status || '—',
    priority: priority || '—',
    assignee: assignee || '—',
    lastUpdated: lastUpdated ? new Date(lastUpdated).toLocaleString() : '—',
    url,
    properties: cleanProps,
    githubLinks: uniqueLinks,
    prs: [], // filled in by the caller using github helpers
  };
}

/**
 * Extract GitHub URLs from a Notion block.
 */
function extractGitHubLinksFromBlock(block: any): string[] {
  const links: string[] = [];
  const blockType = block.type;

  if (!blockType || !block[blockType]) return links;

  const content = block[blockType];

  // Check rich_text arrays
  if (content.rich_text) {
    for (const segment of content.rich_text) {
      // Check href
      if (segment.href) {
        const hrefs = extractGitHubLinksFromText(segment.href);
        links.push(...hrefs);
      }
      // Check plain text for URLs
      if (segment.plain_text) {
        const textLinks = extractGitHubLinksFromText(segment.plain_text);
        links.push(...textLinks);
      }
    }
  }

  // Check URL property (for bookmark, embed blocks)
  if (content.url) {
    const urlLinks = extractGitHubLinksFromText(content.url);
    links.push(...urlLinks);
  }

  return links;
}

/**
 * Extract GitHub PR/repo URLs from text.
 */
function extractGitHubLinksFromText(text: string): string[] {
  const links: string[] = [];
  // Match GitHub PR URLs
  const prRegex = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
  const prMatches = text.match(prRegex);
  if (prMatches) links.push(...prMatches);

  // Match GitHub repo URLs (not PRs, issues, etc.)
  const repoRegex = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/[\w./-]+)?/g;
  const repoMatches = text.match(repoRegex);
  if (repoMatches) {
    for (const match of repoMatches) {
      if (!links.includes(match)) links.push(match);
    }
  }

  return links;
}

/**
 * Inspect a Notion page or database — dump full structure.
 */
export async function inspectPage(notion: Client, pageId: string): Promise<any> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return { type: 'page', data: page };
  } catch {
    // Might be a database
    try {
      const db = await notion.databases.retrieve({ database_id: pageId });
      return { type: 'database', data: db };
    } catch (err: any) {
      throw new Error(`Could not retrieve as page or database: ${err.message}`);
    }
  }
}
