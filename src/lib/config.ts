import * as fs from 'fs';
import * as path from 'path';
import { EqConfig } from '../types';

const CONFIG_PATH = path.join(process.env.HOME || '~', '.eqrc.json');

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

/**
 * Load config with full validation — requires notionApiKey.
 * Throws if config is missing or incomplete (unless local mode is available).
 */
export function loadConfig(): EqConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Check if local mode is available before failing
    if (isLocalMode()) {
      return loadConfigPermissive()!;
    }
    throw new Error(
      'Config not found. Run `eq setup` first to configure your environment.'
    );
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as EqConfig;

    // If no API key, allow it if local mode is available
    if (!config.notionApiKey && !isLocalMode()) {
      throw new Error(
        'No Notion API key configured. Run `eq setup` to add one, or `tix sync` to use MCP-based sync.'
      );
    }

    if (!config.notionDatabaseId || !config.userName) {
      throw new Error('Config is incomplete. Run `eq setup` to reconfigure.');
    }

    return config;
  } catch (err: any) {
    if (err.message.includes('Config is incomplete') || err.message.includes('Config not found') || err.message.includes('No Notion API key')) {
      throw err;
    }
    throw new Error(`Failed to read config at ${CONFIG_PATH}: ${err.message}`);
  }
}

/**
 * Load config without requiring notionApiKey.
 * Returns null if config file doesn't exist.
 */
export function loadConfigPermissive(): EqConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as EqConfig;
  } catch {
    return null;
  }
}

/**
 * Check if local mode is available — .tix/tickets/ exists with files.
 * This allows tix to work without a Notion API key by reading
 * locally synced ticket files.
 */
export function isLocalMode(): boolean {
  const tixDir = findTixDir();
  if (!tixDir) return false;

  const ticketsDir = path.join(tixDir, 'tickets');
  if (!fs.existsSync(ticketsDir)) return false;

  try {
    const files = fs.readdirSync(ticketsDir).filter(f => f.endsWith('.md'));
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Find the .tix directory by walking up from cwd.
 */
export function findTixDir(): string | null {
  let dir = process.cwd();
  while (dir !== '/') {
    const tixPath = path.join(dir, '.tix');
    if (fs.existsSync(tixPath)) return tixPath;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Get the last synced date from .tix/index.json.
 */
export function getLastSyncedDate(): string | null {
  const tixDir = findTixDir();
  if (!tixDir) return null;

  const indexPath = path.join(tixDir, 'index.json');
  if (!fs.existsSync(indexPath)) return null;

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    return index.lastSynced || null;
  } catch {
    return null;
  }
}

export function saveConfig(config: EqConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Extract a Notion ID from a URL or raw ID string.
 * Notion URLs look like:
 *   https://www.notion.so/workspace/Page-Title-abc123def456...
 *   https://www.notion.so/abc123def456...
 *   https://www.notion.so/workspace/abc123def456...?v=...
 * Database IDs are 32 hex chars, pages are 32 hex chars.
 */
export function extractNotionId(input: string): string {
  // Already a clean 32-char hex ID (with or without dashes)
  const cleanId = input.replace(/-/g, '');
  if (/^[a-f0-9]{32}$/i.test(cleanId)) {
    return formatNotionId(cleanId);
  }

  // Try to extract from URL
  const urlMatch = input.match(/([a-f0-9]{32})/i);
  if (urlMatch) {
    return formatNotionId(urlMatch[1]);
  }

  // Try the last segment after the last dash (Notion page URLs encode ID at end)
  const lastSegment = input.split('/').pop()?.split('?')[0] || '';
  const endMatch = lastSegment.match(/([a-f0-9]{32})$/i);
  if (endMatch) {
    return formatNotionId(endMatch[1]);
  }

  throw new Error(
    `Could not extract a Notion ID from: ${input}\n` +
    'Expected a 32-character hex ID or a Notion URL.'
  );
}

function formatNotionId(hex: string): string {
  // Format as 8-4-4-4-12
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
