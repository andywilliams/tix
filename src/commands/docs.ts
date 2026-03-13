import inquirer from 'inquirer';
import fs from 'fs/promises';
import path from 'path';

const API_BASE = process.env.TIX_KANBAN_API || 'http://localhost:3001/api';

interface DocumentData {
  id: string;
  path: string;
  title: string;
  content: string;
  lastModified: string;
}

/**
 * Add documents to index
 */
export async function docsAddCommand(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    console.error('Error: No paths provided. Usage: tix docs add <path> [<path2> ...]');
    process.exit(1);
  }

  // Validate paths exist
  for (const p of paths) {
    try {
      await fs.access(p);
    } catch {
      console.error(`Error: Path does not exist: ${p}`);
      process.exit(1);
    }
  }

  try {
    const response = await fetch(`${API_BASE}/documents/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to index documents: ${error}`);
    }

    const result = await response.json() as any;
    console.log(`✅ Indexed ${result.count || paths.length} documents from:`);
    paths.forEach(p => console.log(`   - ${p}`));
  } catch (err: any) {
    console.error(`Error indexing documents: ${err.message}`);
    process.exit(1);
  }
}

/**
 * List indexed documents
 */
export async function docsListCommand(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/documents`);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch documents: ${error}`);
    }

    const documents: DocumentData[] = (await response.json()) as DocumentData[];
    
    if (documents.length === 0) {
      console.log('No documents indexed yet. Use `tix docs add <path>` to add some.');
      return;
    }

    console.log(`\n📚 Indexed Documents (${documents.length} total)\n`);
    
    for (const doc of documents) {
      console.log(`${doc.title}`);
      console.log(`  Path: ${doc.path}`);
      console.log(`  Modified: ${new Date(doc.lastModified).toLocaleDateString()}`);
      console.log();
    }
  } catch (err: any) {
    console.error(`Error listing documents: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Refresh document index
 */
export async function docsRefreshCommand(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/documents/refresh`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh index: ${error}`);
    }

    const result = await response.json() as any;
    console.log(`✅ Refreshed document index (${result.count || 0} documents)`);
  } catch (err: any) {
    console.error(`Error refreshing index: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Search documents
 */
export async function docsSearchCommand(query: string, options: any): Promise<void> {
  if (!query) {
    console.error('Error: No query provided. Usage: tix docs search <query>');
    process.exit(1);
  }

  try {
    const limit = options.limit || 5;
    const url = new URL(`${API_BASE}/documents/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', limit.toString());

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Search failed: ${error}`);
    }

    const documents: DocumentData[] = (await response.json()) as DocumentData[];
    
    if (documents.length === 0) {
      console.log(`No documents found matching "${query}"`);
      return;
    }

    console.log(`\n🔍 Search results for "${query}" (top ${documents.length})\n`);
    
    for (const doc of documents) {
      console.log(`${doc.title}`);
      console.log(`  Path: ${doc.path}`);
      
      // Show snippet of content
      const snippet = doc.content.slice(0, 200).replace(/\n/g, ' ').trim();
      console.log(`  ${snippet}${doc.content.length > 200 ? '...' : ''}`);
      console.log();
    }
  } catch (err: any) {
    console.error(`Error searching documents: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main docs command dispatcher
 */
export async function docsCommand(action: string, ...args: string[]): Promise<void> {
  const [firstArg, ...restArgs] = args;

  switch (action) {
    case 'add':
      await docsAddCommand(args);
      break;
    
    case 'list':
      await docsListCommand();
      break;
    
    case 'refresh':
      await docsRefreshCommand();
      break;
    
    case 'search':
      // Check for --limit option
      const limitIndex = restArgs.indexOf('--limit');
      const limit = limitIndex !== -1 ? parseInt(restArgs[limitIndex + 1]) : 5;
      const query = limitIndex !== -1 
        ? [firstArg, ...restArgs.slice(0, limitIndex)].join(' ')
        : args.join(' ');
      
      await docsSearchCommand(query, { limit });
      break;
    
    default:
      console.error(`Unknown action: ${action}`);
      console.log('\nUsage:');
      console.log('  tix docs add <path> [<path2> ...]    # Add documents to index');
      console.log('  tix docs list                         # List indexed documents');
      console.log('  tix docs refresh                      # Re-index all documents');
      console.log('  tix docs search <query> [--limit N]   # Search for documents');
      process.exit(1);
  }
}
