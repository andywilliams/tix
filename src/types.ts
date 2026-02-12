export interface EqConfig {
  notionApiKey?: string;
  notionDatabaseId?: string;
  notionDataSourceId?: string;
  notionDatabaseUrl?: string;
  notionUserId?: string;
  userName: string;
  githubOrg: string;
}

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  priority: string;
  lastUpdated: string;
  url: string;
  githubLinks: string[];
}

export interface PRInfo {
  url: string;
  repo: string;
  number: number;
  state: string;       // open, merged, closed
  title: string;
  checks: string;      // pass, fail, pending
  reviews: string;     // approved, changes_requested, pending
  author: string;
  unresolvedComments: number;
}

export interface TicketDetail {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  lastUpdated: string;
  url: string;
  properties: Record<string, any>;
  githubLinks: string[];
  prs: PRInfo[];
}

// Review types (ported from lgtm)

export type Harshness = 'chill' | 'medium' | 'pedantic';
export type Severity = 'BUG' | 'SECURITY' | 'SUGGESTION' | 'NITPICK';
export type AIProvider = 'claude' | 'codex';

export interface ReviewComment {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
}

export interface PRDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface ReviewSettings {
  ai: AIProvider;
  harshness: Harshness;
  fullContext: boolean;
  usageContext: boolean;
}

export interface CachedPR {
  number: number;
  title: string;
  url: string;
  repo: string;
  ticketId: string;
  reviewDecision: string;
  unresolvedComments: number;
  updatedAt: string;
}

export type CompletedPeriod = 'none' | 'week' | '2weeks' | 'month' | 'quarter' | 'year';

export interface StatusSettings {
  completedPeriod: CompletedPeriod;
}
