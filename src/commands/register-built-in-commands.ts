/**
 * Commander adapter: registers Built-in Command definitions and the global options.
 * Plugin Commands are not involved; they keep using the Commander `program` directly.
 */
import type { Command } from 'commander';
import { builtInCommands, globalOptions, type BuiltInCommand, type BuiltInCommandOptions } from './built-in-commands.js';

function registerBuiltInCommand(program: Command, definition: BuiltInCommand): void {
  const argumentDefinitions = definition.arguments ?? [];
  const command = program.command(definition.name).description(definition.description);

  for (const argument of argumentDefinitions) {
    const syntax = argument.required ? `<${argument.name}>` : `[${argument.name}]`;
    command.argument(syntax, argument.description, argument.defaultValue);
  }
  for (const option of definition.options ?? []) {
    command.option(option.flags, option.description);
  }
  if (definition.examples?.length) {
    command.addHelpText('after', `\nExamples:\n${definition.examples.map((example) => `  $ ${example}`).join('\n')}`);
  }

  // Commander calls the action with (...arguments, options, command).
  command.action((...values: unknown[]) => {
    const args = Object.fromEntries(
      argumentDefinitions.map((argument, index) => [argument.name, values[index] as string | undefined]),
    );
    return definition.run(args, values[argumentDefinitions.length] as BuiltInCommandOptions);
  });
}

export function registerBuiltInCommands(program: Command): void {
  for (const definition of builtInCommands) {
    registerBuiltInCommand(program, definition);
  }
  for (const option of globalOptions) {
    program.option(option.flags, option.description);
  }
}
