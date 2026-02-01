import { execSync } from 'child_process';
import { PRInfo } from '../types';

/**
 * Check if `gh` CLI is available and authenticated.
 */
export function checkGhCli(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a GitHub PR URL into owner/repo and PR number.
 */
export function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

/**
 * Fetch PR information using `gh` CLI.
 */
export async function getPRInfo(prUrl: string): Promise<PRInfo | null> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) return null;

  const { owner, repo, number } = parsed;
  const fullRepo = `${owner}/${repo}`;

  try {
    // Get PR details
    const prJson = execSync(
      `gh pr view ${number} --repo ${fullRepo} --json title,state,author,reviewDecision,statusCheckRollup`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );

    const pr = JSON.parse(prJson);

    // Map state
    let state = 'open';
    if (pr.state === 'MERGED') state = 'merged';
    else if (pr.state === 'CLOSED') state = 'closed';

    // Map checks
    let checks = 'none';
    if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
      const allPassed = pr.statusCheckRollup.every(
        (c: any) => c.conclusion === 'SUCCESS' || c.status === 'COMPLETED'
      );
      const anyFailed = pr.statusCheckRollup.some(
        (c: any) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR'
      );
      const anyPending = pr.statusCheckRollup.some(
        (c: any) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING'
      );

      if (anyFailed) checks = 'fail';
      else if (anyPending) checks = 'pending';
      else if (allPassed) checks = 'pass';
    }

    // Map review status
    let reviews = 'pending';
    if (pr.reviewDecision === 'APPROVED') reviews = 'approved';
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') reviews = 'changes_requested';
    else if (pr.reviewDecision === 'REVIEW_REQUIRED') reviews = 'pending';

    return {
      url: prUrl,
      repo: fullRepo,
      number,
      state,
      title: pr.title || '',
      checks,
      reviews,
      author: pr.author?.login || '',
    };
  } catch (err: any) {
    // Return a minimal info object on failure
    return {
      url: prUrl,
      repo: fullRepo,
      number,
      state: 'unknown',
      title: '(could not fetch)',
      checks: 'unknown',
      reviews: 'unknown',
      author: '',
    };
  }
}

/**
 * Get a formatted PR reference string (e.g. "owner/repo#123").
 */
export function formatPRRef(url: string): string {
  const parsed = parsePRUrl(url);
  if (!parsed) return url;
  return `${parsed.owner}/${parsed.repo}#${parsed.number}`;
}
