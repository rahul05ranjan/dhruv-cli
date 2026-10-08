import { Command } from 'commander';
import { context, type NanoContextResponse } from './context.js';
import { resolveWorkspace } from './discovery.js';
import { purgeIndex, refreshIndex, type NanoIndexReport } from './index.js';

interface ContextOptions {
  json?: boolean;
  root?: string;
  scope?: string;
  top?: string;
  maxRefreshFiles?: string;
  maxRefreshBytes?: string;
}

function printReport(report: NanoIndexReport, json?: boolean): void {
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Nano index: ${report.freshness}`);
    console.log(`Identity: ${report.identity ?? 'none'}`);
    console.log(`Coverage: ${report.coverage.scanned}/${report.coverage.discovered} files`);
    console.log(`Exclusions: ${report.exclusions}`);
    for (const warning of report.warnings) console.error(`Nano: ${warning}`);
  }
}

function runIndexCommand(kind: 'index' | 'status' | 'purge', options: ContextOptions): void {
  try {
    const workspace = resolveWorkspace({ root: options.root, scope: options.scope });
    const report = kind === 'purge' ? purgeIndex(workspace)
      : refreshIndex(workspace, {
        maxFiles: options.maxRefreshFiles === undefined ? undefined : Number(options.maxRefreshFiles),
        maxBytes: options.maxRefreshBytes === undefined ? undefined : Number(options.maxRefreshBytes),
        persist: kind === 'index',
      }).report;
    printReport(report, options.json);
  } catch (error) {
    console.error(`Nano: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

function addIndexOptions(command: Command, refresh: boolean): Command {
  command.option('--json', 'Emit one versioned JSON response')
    .option('--root <path>', 'Workspace root (defaults to the containing Git repository)')
    .option('--scope <path>', 'Limit the index to a directory inside the workspace root');
  if (refresh) command.option('--max-refresh-files <count>', 'Maximum files verified during refresh')
    .option('--max-refresh-bytes <count>', 'Maximum source bytes read during refresh');
  return command;
}

function printText(response: NanoContextResponse): void {
  if (response.files.length === 0) {
    console.log('No supported file match found.');
  } else {
    for (const file of response.files) {
      console.log(file.path);
      for (const evidence of file.evidence.slice(0, 3)) {
        console.log(`  ${evidence.kind}${evidence.line ? `:${evidence.line}` : ''} ${evidence.detail}`);
      }
    }
  }
  for (const warning of response.warnings) console.error(`Nano: ${warning}`);
}

/** Registration is shared by the isolated entry path and ordinary command help. */
export function registerNanoCommands(program: Command): void {
  const nano = program.command('nano').description('Local repository context discovery');
  nano.command('context')
    .description('Find on-disk files relevant to a task without a model')
    .argument('<task>', 'Task or question to locate files for')
    .option('--json', 'Emit one versioned JSON response')
    .option('--root <path>', 'Workspace root (defaults to the containing Git repository)')
    .option('--scope <path>', 'Limit results to a directory inside the workspace root')
    .option('--top <count>', 'Maximum number of files, from 1 to 30')
    .option('--max-refresh-files <count>', 'Maximum files verified during refresh')
    .option('--max-refresh-bytes <count>', 'Maximum source bytes read during refresh')
    .addHelpText('after', '\nExample:\n  $ dhruv nano context "Fix token refresh in src/auth/token.ts" --json')
    .action((task: string, options: ContextOptions) => {
      try {
        const response = context({ task, root: options.root, scope: options.scope, top: options.top === undefined ? undefined : Number(options.top),
          maxRefreshFiles: options.maxRefreshFiles === undefined ? undefined : Number(options.maxRefreshFiles),
          maxRefreshBytes: options.maxRefreshBytes === undefined ? undefined : Number(options.maxRefreshBytes) });
        if (options.json) console.log(JSON.stringify(response));
        else printText(response);
      } catch (error) {
        console.error(`Nano: ${(error as Error).message}`);
        process.exitCode = 2;
      }
    });
  addIndexOptions(nano.command('index').description('Build or refresh the local Nano index'), true)
    .action((options: ContextOptions) => runIndexCommand('index', options));
  addIndexOptions(nano.command('status').description('Inspect local Nano index freshness'), true)
    .action((options: ContextOptions) => runIndexCommand('status', options));
  addIndexOptions(nano.command('purge').description('Remove the local Nano index'), false)
    .action((options: ContextOptions) => runIndexCommand('purge', options));
}

export async function runNanoCli(argv: string[]): Promise<void> {
  const program = new Command().name('dhruv').description('Dhruv CLI');
  registerNanoCommands(program);
  await program.parseAsync(argv);
}
