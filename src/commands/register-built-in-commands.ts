/**
 * Commander adapter: registers Built-in Command definitions and the global options.
 * Plugin Commands are not involved; they keep using the Commander `program` directly.
 */
import type { Command } from 'commander';
import { builtInCommands, globalOptions, findBuiltInCommand, type BuiltInCommand, type BuiltInCommandOptions } from './built-in-commands.js';
import { routeIntent } from '../core/intent-routing.js';

export interface DispatchContext {
  isTTY?: boolean;
}

export async function dispatchRootQuery(
  query: string,
  options: BuiltInCommandOptions = {},
  context: DispatchContext = {}
): Promise<void> {
  const isTTY = context.isTTY ?? Boolean(process.stdout?.isTTY);
  const routing = await routeIntent(query);

  if (routing.fallbackToMenu || !routing.command) {
    if (isTTY) {
      const menuCmd = findBuiltInCommand('menu');
      if (menuCmd) {
        return menuCmd.run({ filter: query.trim() || undefined }, options);
      }
    } else {
      const { printError } = await import('../utils/ux.js');
      printError(`Low routing confidence for query: "${query}". Specify a subcommand (e.g. dhruv explain, dhruv review) or run interactively.`);
      process.exitCode = 1;
      return;
    }
  }

  const targetCmd = findBuiltInCommand(routing.command);
  if (!targetCmd) {
    const { printError } = await import('../utils/ux.js');
    printError(`Unknown routed command "${routing.command}".`);
    process.exitCode = 1;
    return;
  }

  const argDefs = targetCmd.arguments ?? [];
  const args: Record<string, string | undefined> = {};

  if (argDefs.length > 0) {
    const primaryArg = argDefs[0];
    if (primaryArg.name === 'query') {
      args[primaryArg.name] = routing.args[0] ?? query;
    } else {
      args[primaryArg.name] = routing.target ?? routing.args[0] ?? primaryArg.defaultValue;
    }
    if (argDefs.length > 1 && routing.target) {
      args[argDefs[1].name] = routing.target;
    }
  }

  if (!options.json) {
    const { default: chalk } = await import('chalk');
    const percentage = Math.round(routing.confidence * 100);
    const targetInfo = routing.target ? ` on ${chalk.bold(routing.target)}` : '';
    console.log(chalk.cyan(`⚡ Routed via Laya Intent Model → `) + chalk.bold(routing.command) + chalk.cyan(targetInfo) + chalk.dim(` (${percentage}% confidence)\n`));
  }

  return targetCmd.run(args, options);
}

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

  program
    .argument('[query...]', 'Natural-language request to auto-route to a command')
    .action(async (queryParts: string[], cmdOptions: BuiltInCommandOptions) => {
      const query = (queryParts || []).join(' ');
      await dispatchRootQuery(query, cmdOptions);
    });
}
