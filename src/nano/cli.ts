import { Command } from 'commander';
import { context, type NanoContextResponse } from './context.js';

interface ContextOptions {
  json?: boolean;
  root?: string;
  scope?: string;
  top?: string;
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
    .addHelpText('after', '\nExample:\n  $ dhruv nano context "Fix token refresh in src/auth/token.ts" --json')
    .action((task: string, options: ContextOptions) => {
      try {
        const response = context({ task, root: options.root, scope: options.scope, top: options.top === undefined ? undefined : Number(options.top) });
        if (options.json) console.log(JSON.stringify(response));
        else printText(response);
      } catch (error) {
        console.error(`Nano: ${(error as Error).message}`);
        process.exitCode = 2;
      }
    });
}

export async function runNanoCli(argv: string[]): Promise<void> {
  const program = new Command().name('dhruv').description('Dhruv CLI');
  registerNanoCommands(program);
  await program.parseAsync(argv);
}
