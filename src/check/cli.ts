/**
 * Entry point for `dhruv check`. It builds a bare program with only `check` and the
 * global options, so repository-local Plugin Commands and the full startup
 * sequence never run before a possibly untrusted change is reviewed.
 */
import { Command, CommanderError } from 'commander';
import { checkCommand } from '../commands/definitions/check-command.js';
import { applyGlobalOptions, globalOptions } from '../commands/global-options.js';
import { setSessionConfig } from '../config/config.js';
import { presentCheckResult } from '../core/check-presentation.js';

export async function runCheckCli(argv: string[]): Promise<void> {
  const program = new Command().name('dhruv');
  program.exitOverride();
  const command = program.command(checkCommand.name).description(checkCommand.description);
  for (const option of checkCommand.options ?? []) command.option(option.flags, option.description);
  command.addHelpText('after', `\nExamples:\n${(checkCommand.examples ?? []).map((example) => `  $ ${example}`).join('\n')}`);
  command.addHelpText('after', `\nNotes:\n${(checkCommand.notes ?? []).map((note) => `  ${note}`).join('\n')}`);
  command.action((options: Record<string, unknown>) => checkCommand.run({}, options));
  for (const option of globalOptions) program.option(option.flags, option.description);
  program.hook('preAction', (thisCommand) => applyGlobalOptions(thisCommand.opts()));
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode === 0) return; // --help is a successful display, not a check result.
    if (argv.includes('--json')) setSessionConfig({ responseFormat: 'json' });
    presentCheckResult({
      status: 'error',
      error: { kind: 'invalid-input', message: error.message, hint: 'Run: dhruv check --help' },
    });
  }
}
