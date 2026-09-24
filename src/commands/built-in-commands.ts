/**
 * Built-in Command definitions: the canonical facts for every Built-in Command.
 *
 * Command-line registration, the interactive menu and shell completion are
 * adapters over `builtInCommands`. Definitions live in one file per bucket under
 * `./definitions/` and are composed here, in catalog order.
 *
 * Adapters must read `builtInCommands` lazily (inside functions), never at module
 * load time: definition actions import command modules that import the adapters.
 */
import { queryCommands } from './definitions/query-commands.js';
import { sourceCommands } from './definitions/source-commands.js';
import { diagnosticCommands } from './definitions/diagnostic-commands.js';

export interface BuiltInArgument {
  /** Name used in help (`<name>`/`[name]`) and as the key in `BuiltInCommandArgs`. */
  name: string;
  required: boolean;
  /** Commander argument description; adds an Arguments section to help. */
  description?: string;
  /** Commander default, also the menu prompt default. */
  defaultValue?: string;
  /** Suggested values for the menu and completion. Not enforced on the command line. */
  choices?: readonly string[];
  /** Complete file paths for this argument. */
  completeFiles?: boolean;
  /** Menu question. Arguments without one are not asked for in the menu. */
  menuPrompt?: string;
}

export interface BuiltInOption {
  /** Commander flags, e.g. `--output <path>`. */
  flags: string;
  description: string;
}

export type BuiltInCommandArgs = Readonly<Record<string, string | undefined>>;
export type BuiltInCommandOptions = Readonly<Record<string, unknown>>;

export interface BuiltInCommand {
  name: string;
  description: string;
  menuLabel: string;
  arguments?: readonly BuiltInArgument[];
  options?: readonly BuiltInOption[];
  /** Help examples, without the leading `$ `. */
  examples?: readonly string[];
  /** Printed by the menu instead of running the command. */
  menuHint?: string;
  /** Runs the command. Args are keyed by argument name; the menu passes `{}` options. */
  run(args: BuiltInCommandArgs, options: BuiltInCommandOptions): Promise<void> | void;
}

/** Program-level options shared by every command. */
export const globalOptions: readonly BuiltInOption[] = [
  { flags: '--model <model>', description: 'Set Ollama model' },
  { flags: '--verbose', description: 'Enable verbose output' },
  { flags: '--json', description: 'Output in JSON format' },
  { flags: '--timeout <milliseconds>', description: 'Set the AI request timeout' },
];

export const builtInCommands: readonly BuiltInCommand[] = [
  ...queryCommands,
  ...sourceCommands,
  ...diagnosticCommands,
];

export function findBuiltInCommand(name: string): BuiltInCommand | undefined {
  return builtInCommands.find((command) => command.name === name);
}
