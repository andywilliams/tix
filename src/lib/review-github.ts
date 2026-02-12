import { execSync } from 'child_process';
import type { PRDetails } from '../types';

function gh(args: string, repo?: string): string {
  const repoFlag = repo ? `-R ${repo}` : '';
  const cmd = `gh ${args} ${repoFlag}`.trim();
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error: any) {
    throw new Error(`GitHub CLI error: ${error.message}\nCommand: ${cmd}`);
  }
}

export function getPRDetails(prNumber: number, repo?: string): PRDetails {
  const json = gh(
    `pr view ${prNumber} --json number,title,body,author,baseRefName,headRefName,additions,deletions,changedFiles`,
    repo
  );
  const data = JSON.parse(json);
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    author: data.author?.login || 'unknown',
    baseRef: data.baseRefName,
    headRef: data.headRefName,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changedFiles,
  };
}

export function getPRDiff(prNumber: number, repo?: string): string {
  return gh(`pr diff ${prNumber}`, repo);
}

export function getChangedFiles(prNumber: number, repo?: string): string[] {
  const json = gh(`pr view ${prNumber} --json files`, repo);
  const data = JSON.parse(json);
  return (data.files || []).map((f: { path: string }) => f.path);
}

export function getFileContent(prNumber: number, filePath: string, repo?: string): string | null {
  try {
    const repoPath = repo || getRepoFromGit();
    const [owner, repoName] = repoPath.split('/');

    const prJson = gh(`pr view ${prNumber} --json headRefName`, repo);
    const { headRefName } = JSON.parse(prJson);

    const content = execSync(
      `gh api repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}?ref=${headRefName} --jq '.content'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    return Buffer.from(content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export function submitReview(
  prNumber: number,
  comments: Array<{ file: string; line: number; body: string }>,
  repo?: string
): void {
  const repoPath = repo || getRepoFromGit();
  const [owner, repoName] = repoPath.split('/');

  const prJson = gh(`pr view ${prNumber} --json headRefOid`, repo);
  const { headRefOid } = JSON.parse(prJson);

  const payload = JSON.stringify({
    commit_id: headRefOid,
    event: 'COMMENT',
    comments: comments.map(c => ({
      path: c.file,
      line: c.line,
      body: c.body,
      side: 'RIGHT',
    })),
  });

  const cmd = `api repos/${owner}/${repoName}/pulls/${prNumber}/reviews -X POST --input -`;
  execSync(`gh ${cmd}`, {
    input: payload,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function getRepoFromGit(): string {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {
    // ignore
  }
  throw new Error('Could not determine repo. Use --repo owner/repo');
}
