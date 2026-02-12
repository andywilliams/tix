import * as fs from 'fs';
import * as path from 'path';
import { EqConfig } from '../types';

const CONFIG_PATH = path.join(process.env.HOME || '~', '.eqrc.json');

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): EqConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      'Config not found. Run `eq setup` first to configure your environment.'
    );
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as EqConfig;

    if (!config.userName) {
      throw new Error('Config is incomplete. Run `eq setup` to reconfigure.');
    }

    return config;
  } catch (err: any) {
    if (err.message.includes('Config is incomplete') || err.message.includes('Config not found')) {
      throw err;
    }
    throw new Error(`Failed to read config at ${CONFIG_PATH}: ${err.message}`);
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

export function hasNotionApiConfig(config: EqConfig): boolean {
  return !!(config.notionApiKey && config.notionDatabaseId);
}
