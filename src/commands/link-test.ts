import { existsSync } from 'fs';
import path from 'path';
import { resolve } from 'path';

const DWLF_API_BASE = 'https://api.dwlf.co.uk/v2';
const TIX_KANBAN_API_BASE = process.env.TIX_KANBAN_URL || 'http://localhost:3001/api';

interface LinkTestOptions {
  repo?: string;
  unlink?: boolean;
  backend?: 'dwlf' | 'local';
}

async function linkTestDwlf(taskId: string, suitePath: string, options: LinkTestOptions): Promise<void> {
  const apiKey = process.env.DWLF_API_KEY;
  if (!apiKey) {
    console.error('Error: DWLF_API_KEY environment variable is required');
    console.error('Set it with: export DWLF_API_KEY=dwlf_sk_...');
    process.exit(1);
  }

  // Verify the task exists
  const taskRes = await fetch(`${DWLF_API_BASE}/kanban/tasks/${taskId}`, {
    headers: { 'Authorization': `ApiKey ${apiKey}` },
  });

  if (!taskRes.ok) {
    if (taskRes.status === 404) {
      console.error(`Task ${taskId} not found on DWLF kanban`);
    } else {
      console.error(`Failed to fetch task: ${taskRes.status} ${taskRes.statusText}`);
    }
    process.exit(1);
  }

  const taskData = await taskRes.json() as any;
  const task = taskData.task || taskData;

  // Update the task description to include the test suite link
  const testSuiteMarker = '<!-- test-suites -->';
  const testSuiteEndMarker = '<!-- /test-suites -->';
  let description = task.description || '';

  // Parse existing test suite links from description
  const existingSuites: string[] = [];
  const markerRegex = new RegExp(`${testSuiteMarker}([\\s\\S]*?)${testSuiteEndMarker}`);
  const match = description.match(markerRegex);
  if (match) {
    const block = match[1];
    const lineRegex = /- `([^`]+)`/g;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      // Normalize paths from description to match incoming path format
      existingSuites.push(path.normalize(lineMatch[1].replace(/^\.\//, '')));
    }
  }

  if (options.unlink) {
    // Remove the suite
    const idx = existingSuites.indexOf(suitePath);
    if (idx === -1) {
      console.error(`Test suite "${suitePath}" is not linked to task ${taskId}`);
      process.exit(1);
    }
    existingSuites.splice(idx, 1);
  } else {
    // Add the suite
    if (existingSuites.includes(suitePath)) {
      console.log(`Test suite "${suitePath}" is already linked to task ${taskId}`);
      return;
    }
    existingSuites.push(suitePath);
  }

  // Rebuild the test suite block
  let newBlock = '';
  if (existingSuites.length > 0) {
    // Preserve existing repo label from description, only override if --repo explicitly provided
    let repoLabel = ' (apix)'; // default
    if (match && !options.repo) {
      // Extract existing repo label and preserve it if --repo not specified
      const existingLabelMatch = match[1].match(/\*\*Linked Test Suites\s*\(([^)]+)\):\*\*/);
      if (existingLabelMatch) {
        repoLabel = ` (${existingLabelMatch[1]})`;
      }
    } else if (options.repo) {
      // Use explicitly provided repo
      repoLabel = ` (${options.repo})`;
    }
    const lines = existingSuites.map(s => `- \`${s}\``).join('\n');
    newBlock = `${testSuiteMarker}\n\n**Linked Test Suites${repoLabel}:**\n${lines}\n\n${testSuiteEndMarker}`;
  }

  if (match) {
    // Use function replacement to avoid $-interpolation issues with paths containing $
    description = description.replace(markerRegex, () => newBlock);
  } else if (newBlock) {
    description = `${description}\n\n${newBlock}`;
  }

  // Update the task
  const updateRes = await fetch(`${DWLF_API_BASE}/kanban/tasks/${taskId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `ApiKey ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description }),
  });

  if (!updateRes.ok) {
    console.error(`Failed to update task: ${updateRes.status} ${updateRes.statusText}`);
    process.exit(1);
  }

  if (options.unlink) {
    console.log(`✓ Unlinked test suite "${suitePath}" from task ${taskId}`);
  } else {
    console.log(`✓ Linked test suite "${suitePath}" to task ${taskId}`);
    if (options.repo) {
      console.log(`  Repo: ${options.repo}`);
    }
  }
}

async function linkTestLocal(taskId: string, suitePath: string, options: LinkTestOptions): Promise<void> {
  if (options.unlink) {
    // Need to find the suite ID first
    const listRes = await fetch(`${TIX_KANBAN_API_BASE}/tasks/${taskId}/test-suites`);
    if (!listRes.ok) {
      console.error(`Failed to fetch task: ${listRes.status} ${listRes.statusText}`);
      process.exit(1);
    }
    const data = await listRes.json() as any;
    // Include repo in the matching logic to handle same path in different repos
    const suite = data.testSuites?.find((s: any) => 
      s.path === suitePath && (!options.repo || s.repo === options.repo)
    );
    if (!suite) {
      console.error(`Test suite "${suitePath}" is not linked to task ${taskId}`);
      process.exit(1);
    }

    const delRes = await fetch(`${TIX_KANBAN_API_BASE}/tasks/${taskId}/test-suites/${suite.id}`, {
      method: 'DELETE',
    });
    if (!delRes.ok) {
      console.error(`Failed to unlink: ${delRes.status} ${delRes.statusText}`);
      process.exit(1);
    }
    console.log(`✓ Unlinked test suite "${suitePath}" from task ${taskId}`);
    return;
  }

  const res = await fetch(`${TIX_KANBAN_API_BASE}/tasks/${taskId}/test-suites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: suitePath,
      repo: options.repo || 'apix', // Store repo explicitly, default to 'apix'
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    if (res.status === 409) {
      console.log(`Test suite "${suitePath}" is already linked to task ${taskId}`);
      return;
    }
    console.error(`Failed to link test suite: ${res.status} ${(body as any).error || res.statusText}`);
    process.exit(1);
  }

  const result = await res.json() as any;
  console.log(`✓ Linked test suite "${suitePath}" to task ${taskId}`);
  console.log(`  Suite ID: ${result.suite.id}`);
  if (options.repo) {
    console.log(`  Repo: ${options.repo}`);
  }
}

export async function linkTestCommand(taskId: string, suitePath: string, options: LinkTestOptions = {}): Promise<void> {
  // Normalize suitePath to prevent match failures (e.g., ./tests/auth vs tests/auth)
  // Only normalize local paths, not URLs
  if (!suitePath.startsWith('http')) {
    suitePath = path.normalize(suitePath.replace(/^\.\//, ''));
  }

  // Validate the test file exists (if it's a local path)
  if (!suitePath.startsWith('http') && !options.unlink) {
    const resolved = resolve(suitePath);
    if (!existsSync(resolved)) {
      console.error(`Warning: Test file not found at "${resolved}"`);
      console.error('The path will still be stored for CI/remote execution.');
    }
  }

  const backend = options.backend || 'dwlf';

  if (backend === 'local') {
    await linkTestLocal(taskId, suitePath, options);
  } else {
    await linkTestDwlf(taskId, suitePath, options);
  }
}
