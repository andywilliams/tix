import { Client } from '@notionhq/client';
import * as fs from 'fs';
import * as path from 'path';
import matter = require('gray-matter');
import { EqConfig, TicketSummary, TicketDetail } from '../types';
import { findTixDir } from './config';

export function createNotionClient(config: EqConfig): Client {
  if (!config.notionApiKey) {
    throw new Error(
      'No Notion API key configured. Use `tix sync` to sync tickets via MCP, or run `tix setup` to add an API key.'
    );
  }
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
      database_id: config.notionDatabaseId,
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

// ────────────────────────────────────────────────────────────────
// Local file readers — for MCP-synced tickets in .tix/
// ────────────────────────────────────────────────────────────────

/**
 * Load all tickets from the local .tix/ cache.
 * Reads .tix/index.json and falls back to scanning .tix/tickets/*.md.
 */
export function loadLocalTickets(): TicketSummary[] {
  const tixDir = findTixDir();
  if (!tixDir) return [];

  // Try index.json first for speed
  const indexPath = path.join(tixDir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(index.tickets)) {
        return index.tickets.map((t: any) => ({
          id: t.id || '',
          title: t.title || '(untitled)',
          status: t.status || '—',
          priority: t.priority || '—',
          lastUpdated: t.lastUpdated
            ? new Date(t.lastUpdated).toLocaleDateString()
            : '—',
          url: t.url || '',
          githubLinks: Array.isArray(t.githubLinks) ? t.githubLinks : [],
        }));
      }
    } catch {
      // Fall through to file scanning
    }
  }

  // Fallback: scan ticket files
  const ticketsDir = path.join(tixDir, 'tickets');
  if (!fs.existsSync(ticketsDir)) return [];

  const files = fs.readdirSync(ticketsDir).filter(f => f.endsWith('.md'));
  const tickets: TicketSummary[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(ticketsDir, file), 'utf-8');
      const { data } = matter(raw);

      tickets.push({
        id: data.id || path.basename(file, '.md'),
        title: data.title || '(untitled)',
        status: data.status || '—',
        priority: data.priority || '—',
        lastUpdated: data.lastUpdated
          ? new Date(data.lastUpdated).toLocaleDateString()
          : '—',
        url: data.url || '',
        githubLinks: Array.isArray(data.githubLinks) ? data.githubLinks : [],
      });
    } catch {
      // Skip malformed files
    }
  }

  return tickets;
}

/**
 * Load full detail for a single ticket from local .tix/ cache.
 */
export function getLocalTicketDetail(id: string): TicketDetail | null {
  const tixDir = findTixDir();
  if (!tixDir) return null;

  const ticketsDir = path.join(tixDir, 'tickets');
  if (!fs.existsSync(ticketsDir)) return null;

  // Try exact filename match (with and without dashes)
  const cleanId = id.replace(/-/g, '');
  const candidates = [
    `${id}.md`,
    `${cleanId}.md`,
  ];

  let filePath: string | null = null;
  for (const candidate of candidates) {
    const full = path.join(ticketsDir, candidate);
    if (fs.existsSync(full)) {
      filePath = full;
      break;
    }
  }

  // If no exact match, scan all files for matching frontmatter ID
  if (!filePath) {
    const files = fs.readdirSync(ticketsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(ticketsDir, file), 'utf-8');
        const { data } = matter(raw);
        const fileId = (data.id || '').replace(/-/g, '');
        if (fileId === cleanId) {
          filePath = path.join(ticketsDir, file);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);

    return {
      id: data.id || id,
      title: data.title || '(untitled)',
      status: data.status || '—',
      priority: data.priority || '—',
      assignee: data.assignee || '—',
      lastUpdated: data.lastUpdated
        ? new Date(data.lastUpdated).toLocaleString()
        : '—',
      url: data.url || '',
      properties: data as Record<string, any>,
      githubLinks: Array.isArray(data.githubLinks) ? data.githubLinks : [],
      prs: [], // filled in by the caller using github helpers
    };
  } catch {
    return null;
  }
}
