import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Harshness, ReviewResult, ReviewComment, Severity, AIProvider } from '../types';

const HARSHNESS_PROMPTS: Record<Harshness, string> = {
  chill: `Only flag issues that are:
- Definite bugs that will cause runtime errors
- Security vulnerabilities
- Breaking changes to public APIs
- Critical missing error handling

Do NOT comment on: style, naming, suggestions, minor improvements, "consider" statements.
If the code works correctly and is safe, return an empty comments array.
Be very conservative — only flag things that are clearly wrong.`,

  medium: `Flag issues including:
- Bugs and potential runtime errors
- Security concerns
- Missing null/undefined checks that could cause issues
- Confusing or error-prone code patterns
- Missing error handling for likely failure cases
- Performance issues that are obvious

Do NOT comment on: minor style preferences, optional improvements.
Focus on things that are likely to cause problems.`,

  pedantic: `Review thoroughly and flag:
- All potential bugs and edge cases
- Security concerns
- Code smells and antipatterns
- Naming that could be clearer
- Missing documentation for complex logic
- Style inconsistencies within the PR
- Performance concerns
- "Consider" suggestions for better approaches
- Missing test coverage for complex logic

Be thorough but constructive. Every comment should be actionable.`,
};

const SYSTEM_PROMPT = `You are a senior code reviewer. Review the provided PR diff and give specific, actionable feedback.

IMPORTANT RULES:
- Only comment on lines that are ADDED (start with + in the diff)
- Use the line number shown after @@ in the diff hunk header for context
- Be specific about what's wrong and how to fix it
- Don't repeat yourself`;

export function checkClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkCodexCli(): boolean {
  try {
    execSync('codex --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getAvailableProviders(): AIProvider[] {
  const providers: AIProvider[] = [];
  if (checkClaudeCli()) providers.push('claude');
  if (checkCodexCli()) providers.push('codex');
  return providers;
}

export async function reviewPR(
  diff: string,
  prTitle: string,
  prBody: string,
  harshness: Harshness,
  ai: AIProvider = 'claude',
  fileContents?: Record<string, string>,
  usageContext?: string
): Promise<ReviewResult> {
  let fileContextSection = '';
  if (fileContents && Object.keys(fileContents).length > 0) {
    fileContextSection = `\n## Full File Contents (for pattern analysis)
Look at how similar code is structured in these files. If the PR adds new code that doesn't follow existing patterns (e.g., missing integration with existing systems, missing registration in arrays/maps where similar items are registered), flag it.

${Object.entries(fileContents).map(([p, content]) =>
  `### ${p}\n\`\`\`\n${content}\n\`\`\``
).join('\n\n')}

IMPORTANT: Compare the PR changes against the existing patterns in the full files above. Flag any inconsistencies where new code doesn't follow established patterns.
`;
  }

  let usageContextSection = '';
  if (usageContext) {
    usageContextSection = usageContext;
  }

  const userPrompt = `${HARSHNESS_PROMPTS[harshness]}

## PR Title
${prTitle}

## PR Description
${prBody || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`
${fileContextSection}${usageContextSection}
OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after.
For each issue found, include in the comments array:
- "file": the file path
- "line": the line number in the new version (from diff lines starting with +)
- "severity": one of "BUG", "SECURITY", "SUGGESTION", "NITPICK"
- "title": a brief title (max 50 chars)
- "body": detailed explanation
- "suggestion": optional code fix

Respond with this exact JSON structure:
{"summary": "Brief overall assessment", "comments": [...]}

If no issues found, respond with:
{"summary": "LGTM — no issues found", "comments": []}`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  const tempFile = path.join(os.tmpdir(), `tix-review-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, fullPrompt);

  try {
    let output: string;

    if (ai === 'codex') {
      const outputFile = tempFile + '.out';
      execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
      output = fs.readFileSync(outputFile, 'utf-8');
      fs.unlinkSync(outputFile);
    } else {
      output = execSync(`claude --print < "${tempFile}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    fs.unlinkSync(tempFile);
    return parseAIResponse(output);
  } catch (error: any) {
    try { fs.unlinkSync(tempFile); } catch {}

    if (error.message?.includes('not found') || error.code === 'ENOENT') {
      const cliName = ai === 'codex' ? 'Codex' : 'Claude';
      const installCmd = ai === 'codex'
        ? 'npm install -g @openai/codex'
        : 'npm install -g @anthropic-ai/claude-code';
      throw new Error(`${cliName} CLI not found. Install it: ${installCmd}`);
    }
    throw error;
  }
}

function parseAIResponse(output: string): ReviewResult {
  let jsonStr = output.trim();

  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const summaryMatch = jsonStr.match(/\{"summary"[\s\S]*\}/);
  if (summaryMatch) {
    jsonStr = summaryMatch[0];
  } else {
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      jsonStr = jsonObjectMatch[0];
    }
  }

  try {
    const result = JSON.parse(jsonStr.trim()) as ReviewResult;
    result.comments = (result.comments || []).map(normalizeComment);
    return result;
  } catch {
    console.error('Failed to parse AI response as JSON');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error('Failed to parse review response from AI');
  }
}

function normalizeComment(comment: any): ReviewComment {
  const validSeverities: Severity[] = ['BUG', 'SECURITY', 'SUGGESTION', 'NITPICK'];
  return {
    file: String(comment.file || ''),
    line: Number(comment.line) || 1,
    severity: validSeverities.includes(comment.severity) ? comment.severity : 'SUGGESTION',
    title: String(comment.title || 'Review comment'),
    body: String(comment.body || ''),
    suggestion: comment.suggestion ? String(comment.suggestion) : undefined,
  };
}
