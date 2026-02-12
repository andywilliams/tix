import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ReviewSettings, StatusSettings } from '../types';

const TIX_DIR = path.join(os.homedir(), '.tix');
const SETTINGS_FILE = path.join(TIX_DIR, 'settings.json');

export function getDefaults(): ReviewSettings {
  return {
    ai: 'claude',
    harshness: 'medium',
    fullContext: true,
    usageContext: true,
  };
}

function loadAllSettings(): Record<string, any> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // Fall through
  }
  return {};
}

function saveAllSettings(all: Record<string, any>): void {
  if (!fs.existsSync(TIX_DIR)) {
    fs.mkdirSync(TIX_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2) + '\n');
}

export function loadReviewSettings(): ReviewSettings {
  const all = loadAllSettings();
  const saved = all.review || {};
  return { ...getDefaults(), ...saved };
}

export function saveReviewSettings(settings: ReviewSettings): void {
  const all = loadAllSettings();
  all.review = settings;
  saveAllSettings(all);
}

export function loadStatusSettings(): StatusSettings {
  const all = loadAllSettings();
  const saved = all.status || {};
  return { completedPeriod: 'week', ...saved };
}

export function saveStatusSettings(settings: StatusSettings): void {
  const all = loadAllSettings();
  all.status = settings;
  saveAllSettings(all);
}
