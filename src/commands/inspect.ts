import chalk from 'chalk';
import { loadConfig, extractNotionId } from '../lib/config';
import { createNotionClient, inspectPage } from '../lib/notion';

export async function inspectCommand(notionUrlOrId: string): Promise<void> {
  const config = loadConfig();
  const notion = createNotionClient(config);

  let pageId: string;
  try {
    pageId = extractNotionId(notionUrlOrId);
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.bold.cyan(`\n🔍 Inspecting ${pageId}\n`));

  let result;
  try {
    result = await inspectPage(notion, pageId);
  } catch (err: any) {
    console.error(chalk.red(`Failed to inspect: ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.bold(`Type: ${result.type}\n`));

  if (result.type === 'database') {
    // Show database properties in a human-readable way
    const db = result.data as any;
    console.log(chalk.bold('Title:'), db.title?.map((t: any) => t.plain_text).join('') || '(untitled)');
    console.log(chalk.bold('ID:'), db.id);
    console.log('');

    if (db.properties) {
      console.log(chalk.bold.underline('Properties:\n'));
      for (const [name, prop] of Object.entries(db.properties) as [string, any][]) {
        console.log(chalk.bold.yellow(`  ${name}`) + chalk.dim(` (${prop.type})`));

        // Show select/multi_select options
        if (prop.type === 'select' && prop.select?.options) {
          for (const opt of prop.select.options) {
            console.log(chalk.dim(`    - ${opt.name}`) + (opt.color ? chalk.dim(` [${opt.color}]`) : ''));
          }
        }
        if (prop.type === 'multi_select' && prop.multi_select?.options) {
          for (const opt of prop.multi_select.options) {
            console.log(chalk.dim(`    - ${opt.name}`) + (opt.color ? chalk.dim(` [${opt.color}]`) : ''));
          }
        }
        if (prop.type === 'status' && prop.status?.options) {
          for (const opt of prop.status.options) {
            console.log(chalk.dim(`    - ${opt.name}`) + (opt.color ? chalk.dim(` [${opt.color}]`) : ''));
          }
          if (prop.status?.groups) {
            console.log(chalk.dim('    Groups:'));
            for (const group of prop.status.groups) {
              const optNames = group.option_ids?.length
                ? ` (${group.option_ids.length} options)`
                : '';
              console.log(chalk.dim(`      - ${group.name}${optNames}`) + (group.color ? chalk.dim(` [${group.color}]`) : ''));
            }
          }
        }
        if (prop.type === 'relation' && prop.relation) {
          console.log(chalk.dim(`    → database: ${prop.relation.database_id || 'unknown'}`));
          console.log(chalk.dim(`    → type: ${prop.relation.type || 'unknown'}`));
        }
        if (prop.type === 'rollup' && prop.rollup) {
          console.log(chalk.dim(`    → relation: ${prop.rollup.relation_property_name || 'unknown'}`));
          console.log(chalk.dim(`    → property: ${prop.rollup.rollup_property_name || 'unknown'}`));
          console.log(chalk.dim(`    → function: ${prop.rollup.function || 'unknown'}`));
        }
      }
    }

    console.log(chalk.dim('\n─── Full JSON ───\n'));
  } else {
    // For pages, show a summary then full JSON
    const page = result.data as any;
    console.log(chalk.bold('ID:'), page.id);
    console.log(chalk.bold('URL:'), page.url || '—');
    console.log(chalk.bold('Created:'), page.created_time || '—');
    console.log(chalk.bold('Updated:'), page.last_edited_time || '—');

    if (page.properties) {
      console.log(chalk.bold.underline('\nProperties:\n'));
      for (const [name, prop] of Object.entries(page.properties) as [string, any][]) {
        console.log(chalk.bold.yellow(`  ${name}`) + chalk.dim(` (${prop.type})`));
      }
    }

    console.log(chalk.dim('\n─── Full JSON ───\n'));
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log('');
}
