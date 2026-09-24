/**
 * Legacy catalog for Built-in Commands not yet migrated to definitions
 * (`src/commands/built-in-commands.ts`). Entries shadowed by a definition are
 * ignored. #129 deletes this module.
 */
import { findBuiltInCommand, type BuiltInArgument } from '../commands/built-in-commands.js';

export interface CommandCatalogEntry {
  name: string;
  description: string;
  menuLabel: string;
  options?: string[];
  /** Completion facts only; Commander registration still lives in index.ts. */
  arguments?: Pick<BuiltInArgument, 'name' | 'choices' | 'completeFiles'>[];
}

export const commandCatalog: CommandCatalogEntry[] = [
  // Legacy source-driven commands: #127 moves these into Built-in Command definitions.
  { name: 'review', description: 'Review code in a file or directory', menuLabel: 'Review', options: ['--diff'], arguments: [{ name: 'file', completeFiles: true }] },
  { name: 'optimize', description: 'Optimize a file (e.g., package.json)', menuLabel: 'Optimize', arguments: [{ name: 'file', completeFiles: true }] },
  { name: 'security-check', description: 'Run a security check on code', menuLabel: 'Security Check', options: ['--strict'], arguments: [{ name: 'file', completeFiles: true }] },
  { name: 'generate', description: 'Generate code/tests for a file', menuLabel: 'Generate', options: ['--apply', '--output', '--overwrite'], arguments: [{ name: 'type', choices: ['tests', 'documentation', 'docs', 'component'] }, { name: 'file', completeFiles: true }] },
  // Legacy diagnostics and setup commands: #128 moves these into Built-in Command definitions.
];

/** Catalog entries that no Built-in Command definition has replaced yet. */
export function legacyCommandCatalog(): CommandCatalogEntry[] {
  return commandCatalog.filter((command) => !findBuiltInCommand(command.name));
}

export function commandDescription(name: string): string {
  return commandCatalog.find((command) => command.name === name)?.description ?? name;
}
