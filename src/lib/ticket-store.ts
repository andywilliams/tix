import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TicketSummary, TicketDetail, CachedPR } from '../types';

const TIX_DIR = path.join(os.homedir(), '.tix');
const TICKETS_DIR = path.join(TIX_DIR, 'tickets');
const SUMMARY_FILE = path.join(TICKETS_DIR, '_summary.json');
const PRS_FILE = path.join(TIX_DIR, '_prs.json');

function ensureTicketsDir(): void {
  if (!fs.existsSync(TICKETS_DIR)) {
    fs.mkdirSync(TICKETS_DIR, { recursive: true });
  }
}

export function saveSyncedTickets(tickets: TicketSummary[]): void {
  ensureTicketsDir();
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(tickets, null, 2) + '\n');
}

export function loadSyncedTickets(): TicketSummary[] {
  if (!fs.existsSync(SUMMARY_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(SUMMARY_FILE, 'utf-8');
    return JSON.parse(raw) as TicketSummary[];
  } catch {
    return [];
  }
}

export function hasSyncedTickets(): boolean {
  return fs.existsSync(SUMMARY_FILE);
}

export function saveTicketDetail(detail: TicketDetail): void {
  ensureTicketsDir();
  const filePath = path.join(TICKETS_DIR, `${detail.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(detail, null, 2) + '\n');
}

export function loadTicketDetail(ticketId: string): TicketDetail | null {
  const filePath = path.join(TICKETS_DIR, `${ticketId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TicketDetail;
  } catch {
    return null;
  }
}

export function findTicketByIdOrUrl(idOrUrl: string, tickets: TicketSummary[]): TicketSummary | undefined {
  const lower = idOrUrl.toLowerCase();
  return tickets.find(t =>
    t.id.toLowerCase() === lower ||
    (t.ticketNumber && t.ticketNumber.toLowerCase() === lower) ||
    t.url.toLowerCase().includes(lower) ||
    t.id.toLowerCase().includes(lower.replace(/-/g, ''))
  );
}

export function saveCachedPRs(prs: CachedPR[]): void {
  ensureTicketsDir();
  fs.writeFileSync(PRS_FILE, JSON.stringify(prs, null, 2) + '\n');
}

export function loadCachedPRs(): CachedPR[] {
  if (!fs.existsSync(PRS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PRS_FILE, 'utf-8')) as CachedPR[];
  } catch {
    return [];
  }
}

export function hasCachedPRs(): boolean {
  return fs.existsSync(PRS_FILE);
}

export function getPRsSyncTimestamp(): Date | null {
  if (!fs.existsSync(PRS_FILE)) return null;
  try {
    return fs.statSync(PRS_FILE).mtime;
  } catch {
    return null;
  }
}

export function getSyncTimestamp(): Date | null {
  if (!fs.existsSync(SUMMARY_FILE)) {
    return null;
  }
  try {
    const stat = fs.statSync(SUMMARY_FILE);
    return stat.mtime;
  } catch {
    return null;
  }
}
