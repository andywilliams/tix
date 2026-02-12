import { execSync } from 'child_process';

export interface ChangedSymbol {
  name: string;
  type: 'function' | 'class' | 'const' | 'type' | 'export';
  file: string;
}

export interface UsageSnippet {
  file: string;
  line: number;
  symbol: string;
  context: string;
}

export function extractChangedSymbols(diff: string): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];
  const seen = new Set<string>();
  let currentFile = '';

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    const content = line.slice(1);

    const funcMatch = content.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
    if (funcMatch && !seen.has(funcMatch[1])) {
      symbols.push({ name: funcMatch[1], type: 'function', file: currentFile });
      seen.add(funcMatch[1]);
    }

    const arrowExportMatch = content.match(/export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (arrowExportMatch && !seen.has(arrowExportMatch[1])) {
      symbols.push({ name: arrowExportMatch[1], type: 'function', file: currentFile });
      seen.add(arrowExportMatch[1]);
    }

    const classMatch = content.match(/(?:export\s+)?class\s+(\w+)/);
    if (classMatch && !seen.has(classMatch[1])) {
      symbols.push({ name: classMatch[1], type: 'class', file: currentFile });
      seen.add(classMatch[1]);
    }

    const typeMatch = content.match(/export\s+(?:type|interface)\s+(\w+)/);
    if (typeMatch && !seen.has(typeMatch[1])) {
      symbols.push({ name: typeMatch[1], type: 'type', file: currentFile });
      seen.add(typeMatch[1]);
    }

    const constMatch = content.match(/export\s+const\s+(\w+)\s*=/);
    if (constMatch && !seen.has(constMatch[1]) && !arrowExportMatch) {
      symbols.push({ name: constMatch[1], type: 'const', file: currentFile });
      seen.add(constMatch[1]);
    }

    const methodMatch = content.match(/^\s+(?:async\s+)?(\w+)\s*(?:=\s*(?:async\s+)?)?\([^)]*\)\s*[:{]/);
    if (methodMatch && !seen.has(methodMatch[1]) && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
      symbols.push({ name: methodMatch[1], type: 'function', file: currentFile });
      seen.add(methodMatch[1]);
    }
  }

  return symbols;
}

export function findUsages(
  symbols: ChangedSymbol[],
  repoRoot: string,
  options: {
    maxUsagesPerSymbol?: number;
    contextLines?: number;
    excludePatterns?: string[];
  } = {}
): UsageSnippet[] {
  const {
    maxUsagesPerSymbol = 5,
    contextLines = 3,
    excludePatterns = ['node_modules', 'dist', 'build', '.git', '*.lock', '*.min.js']
  } = options;

  const snippets: UsageSnippet[] = [];
  const seenLocations = new Set<string>();
  const excludeArgs = excludePatterns.map(p => `-g '!${p}'`).join(' ');

  for (const symbol of symbols) {
    if (['id', 'name', 'value', 'data', 'key', 'type', 'index', 'item', 'get', 'set'].includes(symbol.name)) {
      continue;
    }
    if (symbol.name.length < 2) {
      continue;
    }

    try {
      const pattern = `\\b${symbol.name}\\b`;
      const rgCmd = `rg -n -C ${contextLines} ${excludeArgs} --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs,java,kt}' -t code '${pattern}' "${repoRoot}" 2>/dev/null || true`;

      const output = execSync(rgCmd, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });

      if (!output.trim()) {
        continue;
      }

      const usages = parseRipgrepOutput(output, symbol.name, symbol.file, repoRoot);

      let count = 0;
      for (const usage of usages) {
        const locationKey = `${usage.file}:${usage.line}`;
        if (usage.file === symbol.file) continue;
        if (seenLocations.has(locationKey)) continue;

        seenLocations.add(locationKey);
        snippets.push(usage);
        count++;
        if (count >= maxUsagesPerSymbol) break;
      }
    } catch {
      continue;
    }
  }

  return snippets;
}

function parseRipgrepOutput(
  output: string,
  symbolName: string,
  sourceFile: string,
  repoRoot: string
): UsageSnippet[] {
  const snippets: UsageSnippet[] = [];
  const blocks: string[] = output.split('--\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split('\n');
    let matchFile = '';
    let matchLine = 0;
    const contextLines: string[] = [];

    for (const line of lines) {
      const matchLineMatch = line.match(/^(.+?):(\d+):(.*)$/);
      const contextLineMatch = line.match(/^(.+?)-(\d+)-(.*)$/);

      if (matchLineMatch) {
        const [, file, lineNum, content] = matchLineMatch;
        matchFile = file.replace(repoRoot + '/', '');
        matchLine = parseInt(lineNum, 10);
        contextLines.push(`${lineNum}: ${content}`);
      } else if (contextLineMatch) {
        const [, file, lineNum, content] = contextLineMatch;
        if (!matchFile) {
          matchFile = file.replace(repoRoot + '/', '');
        }
        contextLines.push(`${lineNum}: ${content}`);
      }
    }

    if (matchFile && matchLine > 0 && contextLines.length > 0) {
      const contextText = contextLines.join('\n');
      const hasImport = contextText.includes(`import`) && contextText.includes(symbolName);
      const hasUsageBeyondImport = contextLines.some(l =>
        !l.includes('import') &&
        l.includes(symbolName) &&
        (l.includes(`${symbolName}(`) || l.includes(`${symbolName}.`) || l.includes(`: ${symbolName}`))
      );

      if (hasImport && !hasUsageBeyondImport) {
        continue;
      }

      snippets.push({
        file: matchFile,
        line: matchLine,
        symbol: symbolName,
        context: contextText
      });
    }
  }

  return snippets;
}

export function formatUsageContext(snippets: UsageSnippet[]): string {
  if (snippets.length === 0) {
    return '';
  }

  const byFile = new Map<string, UsageSnippet[]>();
  for (const snippet of snippets) {
    if (!byFile.has(snippet.file)) {
      byFile.set(snippet.file, []);
    }
    byFile.get(snippet.file)!.push(snippet);
  }

  let output = `\n## Usage Context
The following files use symbols being changed in this PR. Consider whether the changes might break or affect these usages.

`;

  for (const [file, fileSnippets] of byFile) {
    const symbols = [...new Set(fileSnippets.map(s => s.symbol))];
    output += `### ${file}\n`;
    output += `**Uses:** ${symbols.join(', ')}\n\n`;

    for (const snippet of fileSnippets) {
      output += `\`\`\`\n${snippet.context}\n\`\`\`\n\n`;
    }
  }

  output += `IMPORTANT: Check if the PR changes might break any of these usages. Flag breaking changes, missing updates to callers, or type mismatches.\n`;

  return output;
}

export function getRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}
