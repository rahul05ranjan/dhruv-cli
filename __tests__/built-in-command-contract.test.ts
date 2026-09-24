/**
 * Contract: every Built-in Command definition is presented identically by the
 * command-line (Commander), interactive menu and shell completion adapters,
 * and both invoking adapters dispatch to the definition's own `run`.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { bashCompletions, itWithBash } from './helpers/bash-completion';
import { builtInCommands, globalOptions, type BuiltInCommand, type BuiltInOption } from '../src/commands/built-in-commands';
import { registerBuiltInCommands } from '../src/commands/register-built-in-commands';
import { completionScript } from '../src/commands/completion';
import { menu } from '../src/commands/menu';
import { themed } from '../src/utils/ux';

jest.mock('chalk', () => {
  const identity = (value: unknown) => String(value);
  const makeChalk = (): unknown => new Proxy(identity, {
    get: (_target, property: string | symbol) => property === 'level' ? 0 : makeChalk(),
    apply: (_target, _thisArg, args: unknown[]) => String(args[0]),
  });
  const chalk = makeChalk() as Record<string, unknown>;
  return { __esModule: true, default: chalk, ...chalk };
});
jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => ({ start: jest.fn().mockReturnThis(), stop: jest.fn().mockReturnThis() })),
}));
jest.mock('inquirer', () => ({ __esModule: true, default: { prompt: jest.fn() } }));
jest.mock('../src/utils/ux', () => ({
  printError: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  createSpinner: jest.fn(),
  themed: jest.fn((value: string) => value),
  highlightCode: jest.fn((value: string) => value),
  createProgressBar: jest.fn(),
}));

const helpOption: BuiltInOption = { flags: '-h, --help', description: 'display help for command' };

function createProgram(): Command {
  const program = new Command().name('dhruv').exitOverride();
  registerBuiltInCommands(program);
  return program;
}

function helpFor(name: string): string {
  const command = createProgram().commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`Command ${name} is not registered`);
  let output = '';
  command.configureOutput({ writeOut: (text) => { output += text; } });
  command.outputHelp();
  return output;
}

/** Entries of a help section ("Options:", "Arguments:"), with wrapped lines joined and spacing collapsed. */
function helpSection(help: string, title: string): string[] {
  const lines = help.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return [];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    if (/^ {2}\S/.test(line)) entries.push(line.trim());
    else entries[entries.length - 1] += ` ${line.trim()}`;
  }
  return entries.map((entry) => entry.replace(/\s+/g, ' '));
}

function flagNames(options: readonly BuiltInOption[]): string[] {
  return options.flatMap((option) => option.flags.split(/[ ,|]+/).filter((token) => token.startsWith('-'))).sort();
}

/** Every flag completion should offer after `name`: its own options, the global options and help. */
function expectedCompletionFlags(definition: BuiltInCommand): string[] {
  return flagNames([...(definition.options ?? []), ...globalOptions, helpOption]);
}

function sampleArgs(definition: BuiltInCommand): Record<string, string> {
  return Object.fromEntries((definition.arguments ?? []).map((argument) => [argument.name, `${argument.name}-value`]));
}

const definitions = builtInCommands.map((definition) => [definition.name, definition] as const);

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(definitions)('Built-in Command %s', (name, definition) => {
  it('shows its name, description, arguments and options in command-line help', () => {
    const help = helpFor(name);
    const args = definition.arguments ?? [];
    const usage = ['Usage: dhruv', name, '[options]', ...args.map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`)];

    expect(help.split('\n')[0]).toBe(usage.join(' '));
    expect(help.split('\n')[2]).toBe(definition.description);
    expect(helpSection(help, 'Options:')).toEqual(
      [...(definition.options ?? []), helpOption].map((option) => `${option.flags} ${option.description}`),
    );
    const describedArgs = args.some((argument) => argument.description) ? args : [];
    expect(helpSection(help, 'Arguments:')).toEqual(describedArgs.map((argument) => [
      argument.name,
      argument.description,
      argument.defaultValue === undefined ? undefined : `(default: "${argument.defaultValue}")`,
    ].filter(Boolean).join(' ')));
    for (const example of definition.examples ?? []) expect(help).toContain(`  $ ${example}`);
  });

  it('dispatches the command line to its definition', async () => {
    const run = jest.spyOn(definition, 'run').mockImplementation(() => undefined);
    const args = sampleArgs(definition);

    await createProgram().parseAsync(['node', 'dhruv', name, ...Object.values(args)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(args, expect.any(Object));
  });

  it('is listed in the menu and dispatches to its definition', async () => {
    const run = jest.spyOn(definition, 'run').mockImplementation(() => undefined);
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    const answers = Object.fromEntries((definition.arguments ?? [])
      .filter((argument) => argument.menuPrompt)
      .map((argument) => [argument.name, argument.choices?.[0] ?? argument.defaultValue ?? `${argument.name}-value`]));
    prompt.mockResolvedValueOnce({ filter: '' }).mockResolvedValueOnce({ cmd: name });
    if (!definition.menuHint && Object.keys(answers).length > 0) prompt.mockResolvedValueOnce(answers);
    prompt.mockResolvedValueOnce({ filter: '' }).mockResolvedValueOnce({ cmd: 'exit' });

    try {
      await menu();

      const choices = (prompt.mock.calls[1][0] as unknown as Array<{ choices: unknown[] }>)[0].choices;
      expect(choices).toContainEqual({ name: definition.menuLabel, value: name });
      if (definition.menuHint) {
        expect(run).not.toHaveBeenCalled();
        expect(themed).toHaveBeenCalledWith(definition.menuHint, 'accent');
      } else {
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(answers, {});
      }
      expect(process.exitCode).toBeUndefined();
    } finally {
      prompt.mockReset();
    }
  });

  itWithBash('is offered by bash completion with exactly its options', () => {
    expect(bashCompletions('')).toContain(name);
    expect(bashCompletions(name, '-').sort()).toEqual(expectedCompletionFlags(definition));
  });

  itWithBash('is offered by bash completion with its argument choices and file paths', () => {
    const args = definition.arguments ?? [];
    args.forEach((argument, index) => {
      const preceding = args.slice(0, index).map((earlier) => earlier.choices?.[0] ?? `${earlier.name}-value`);
      if (argument.choices) expect(bashCompletions(name, ...preceding, '')).toEqual([...argument.choices]);
      if (argument.completeFiles) expect(bashCompletions(name, ...preceding, 'package.j')).toContain('package.json');
    });
  });

  it('is offered by zsh completion with exactly its options', () => {
    const script = completionScript('zsh') ?? '';
    const branch = script.split('\n').find((line) => line.trim().startsWith(`${name})`)) ?? '';

    expect(script).toMatch(new RegExp(`commands=\\(.*\\b${name}\\b.*\\)`));
    expect([...branch.matchAll(/'(-{1,2}[\w-]+)\[/g)].map((match) => match[1]).sort()).toEqual(expectedCompletionFlags(definition));
  });

  it('is offered by zsh completion with its argument choices and file paths', () => {
    const branch = (completionScript('zsh') ?? '').split('\n').find((line) => line.trim().startsWith(`${name})`)) ?? '';
    (definition.arguments ?? []).forEach((argument, index) => {
      if (argument.choices) expect(branch).toContain(`'${index + 1}:${argument.name}:(${argument.choices.join(' ')})'`);
    });
    expect(branch.includes(`'*:file:_files'`)).toBe((definition.arguments ?? []).some((argument) => argument.completeFiles));
  });

  it('is offered by fish completion with its argument choices only at their position', () => {
    const lines = (completionScript('fish') ?? '').split('\n');
    const seen = `__fish_seen_subcommand_from ${name}`;
    (definition.arguments ?? []).forEach((argument, index) => {
      if (!argument.choices) return;
      const choiceLines = lines.filter((line) => line.includes(seen) && line.endsWith(`-a '${argument.choices?.join(' ')}'`));
      expect(choiceLines).toEqual([expect.stringContaining(`(count (commandline -opc)) -eq ${index + 2}`)]);
    });
    const fileLine = lines.find((line) => line.startsWith('complete -c dhruv -') && line.includes(`'${seen}'`) && !/ -[sla] /.test(line));
    expect(fileLine).toContain((definition.arguments ?? []).some((argument) => argument.completeFiles) ? ' -F ' : ' -f ');
  });

  it('is offered by fish completion with exactly its options', () => {
    const lines = (completionScript('fish') ?? '').split('\n');
    const optionLines = lines.filter((line) => line.includes(`'__fish_seen_subcommand_from ${name}'`) && / -[sl] /.test(line));
    const flags = optionLines.flatMap((line) => [...line.matchAll(/ -([sl]) ([\w-]+)/g)]
      .map(([, kind, flag]) => (kind === 's' ? `-${flag}` : `--${flag}`)));

    expect(lines[0]).toMatch(new RegExp(`-a '.*\\b${name}\\b.*'$`));
    expect(flags.sort()).toEqual(expectedCompletionFlags(definition));
  });
});
