export interface EqConfig {
  notionApiKey: string;
  notionDatabaseId: string;
  userName: string;
  githubOrg: string;
}

export interface TicketSummary {
  id: string;
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
