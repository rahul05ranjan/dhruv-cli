import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { explain } from '../src/commands/explain';
import { suggest } from '../src/commands/suggest';
import { fix } from '../src/commands/fix';
import { init } from '../src/commands/init';
import { status } from '../src/commands/status';
import { health } from '../src/commands/health';
import { metrics } from '../src/commands/metrics';
import { menu } from '../src/commands/menu';
import { detectProjectType } from '../src/utils/projectType';
import { registerBuiltInCommands } from '../src/commands/register-built-in-commands';
import { completionScript } from '../src/commands/completion';

jest.mock('chalk', () => {
  const identity = (value: unknown) => String(value);
  const makeChalk = (): unknown => new Proxy(identity, {
    get: (_target, property: string | symbol) => property === 'level' ? 0 : makeChalk(),
    apply: (_target, _thisArg, args: unknown[]) => String(args[0]),
  });
  const chalk = makeChalk() as Record<string, unknown>;
  return { __esModule: true, default: chalk, ...chalk };
});
jest.mock('../src/commands/explain',() => ({ explain: jest.fn() }));
jest.mock('../src/commands/suggest', () => ({ suggest: jest.fn() }));
jest.mock('../src/commands/fix', () => ({ fix: jest.fn() }));
jest.mock('../src/commands/init', () => ({ init: jest.fn() }));
jest.mock('../src/commands/status', () => ({ status: jest.fn() }));
jest.mock('../src/commands/health', () => ({ health: jest.fn() }));
jest.mock('../src/commands/metrics', () => ({ metrics: jest.fn() }));
jest.mock('../src/commands/menu', () => ({ menu: jest.fn() }));
jest.mock('../src/utils/projectType', () => ({ detectProjectType: jest.fn(() => 'go') }));

const queryCommands = [
  { name: 'explain', action: explain, example: 'dhruv explain "What is async/await?"' },
  { name: 'suggest', action: suggest, example: 'dhruv suggest "React performance optimization"' },
  { name: 'fix', action: fix, example: 'dhruv fix "CORS error in Express.js"' },
];

const diagnosticCommands = [
  { name: 'init', usage: 'Usage: dhruv init [options]', argv: [], action: init, expected: [] },
  { name: 'status', usage: 'Usage: dhruv status [options]', argv: [], action: status, expected: [] },
  { name: 'health', usage: 'Usage: dhruv health [options]', argv: ['--details'], action: health, expected: [{ details: true }], help: '--details' },
  { name: 'metrics', usage: 'Usage: dhruv metrics [options]', argv: ['--raw', '--reset'], action: metrics, expected: [{ raw: true, reset: true }], help: '--reset' },
  { name: 'menu', usage: 'Usage: dhruv menu [options]', argv: [], action: menu, expected: [] },
];

function createProgram(): Command {
  const program = new Command().name('dhruv').exitOverride();
  registerBuiltInCommands(program);
  return program;
}

function helpFor(program: Command, name: string): string {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`Command ${name} is not registered`);
  let output = '';
  command.configureOutput({ writeOut: (text) => { output += text; } });
  command.outputHelp();
  return output;
}

describe('Built-in Command line adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(queryCommands)('documents $name with its query argument and examples', ({ name, example }) => {
    const help = helpFor(createProgram(), name);

    expect(help).toContain(`Usage: dhruv ${name} [options] <query>`);
    expect(help).toContain(`$ ${example}`);
  });

  it.each(queryCommands)('runs $name with the query from the command line', async ({ name, action }) => {
    await createProgram().parseAsync(['node', 'dhruv', name, 'why is it slow?']);

    expect(action).toHaveBeenCalledWith('why is it slow?');
  });

  it.each(diagnosticCommands)('documents $name', ({ name, usage, help }) => {
    const text = helpFor(createProgram(), name);

    expect(text).toContain(usage);
    if (help) expect(text).toContain(help);
  });

  it.each(diagnosticCommands)('runs $name from the command line', async ({ name, argv, action, expected }) => {
    await createProgram().parseAsync(['node', 'dhruv', name, ...argv]);

    expect(jest.mocked(action as (...args: unknown[]) => unknown).mock.calls).toEqual([expected]);
  });

  it('prints the detected project type', async () => {
    jest.mocked(console.log).mockClear();

    await createProgram().parseAsync(['node', 'dhruv', 'project-type']);

    expect(detectProjectType).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Detected project type: go');
  });

  it.each([
    { argv: ['zsh'], expected: '#compdef dhruv' },
    { argv: [], expected: 'complete -F _dhruv_completion dhruv' },
  ])('prints the completion script for $argv (bash by default)', async ({ argv, expected }) => {
    jest.mocked(console.log).mockClear();

    await createProgram().parseAsync(['node', 'dhruv', 'completion', ...argv]);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(expected));
  });

  it('documents the completion shell argument', () => {
    const text = helpFor(createProgram(), 'completion');

    expect(text).toContain('Usage: dhruv completion [options] [shell]');
    expect(text).toContain('shell type (bash|zsh|fish) (default: "bash")');
  });

  it('registers the global session options', () => {
    const help = createProgram().helpInformation();

    for (const flag of ['--model <model>', '--verbose', '--json', '--timeout <milliseconds>']) {
      expect(help).toContain(flag);
    }
  });
});

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const itWithBash = bashAvailable ? it : it.skip;

/** Runs the generated bash completion for the given words (the last word is the one being completed). */
function bashCompletions(...words: string[]): string[] {
  const result = spawnSync('bash', ['-c', [
    'eval "$DHRUV_COMPLETION"',
    'COMP_WORDS=(dhruv "$@")',
    'COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))',
    '_dhruv_completion',
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join('\n'), 'bash', ...words], {
    env: { ...process.env, DHRUV_COMPLETION: completionScript('bash') },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

describe('Built-in Command completion adapter', () => {
  itWithBash('offers every Built-in Command name for the first word', () => {
    expect(bashCompletions('')).toEqual(expect.arrayContaining(['explain', 'suggest', 'fix', 'review', 'status', 'completion']));
  });

  itWithBash.each(['explain', 'suggest', 'fix'])('offers only the options %s accepts', (name) => {
    const offered = bashCompletions(name, '--');

    expect(offered).toEqual(expect.arrayContaining(['--help', '--model', '--verbose', '--json', '--timeout']));
    expect(offered).not.toContain('--strict');
    expect(offered).not.toContain('--diff');
    expect(bashCompletions(name, 'question', '')).not.toContain('review');
  });

  itWithBash.each([
    { name: 'health', own: ['--details'] },
    { name: 'metrics', own: ['--raw', '--reset'] },
    { name: 'status', own: [] },
  ])('offers $name its own options and no others', ({ name, own }) => {
    const offered = bashCompletions(name, '--');

    expect(offered).toEqual(expect.arrayContaining([...own, '--help', '--json']));
    expect(offered).not.toContain('--strict');
    expect(offered).not.toContain(name === 'health' ? '--raw' : '--details');
  });

  itWithBash('keeps argument completion for commands without definitions yet', () => {
    expect(bashCompletions('generate', '')).toEqual(['tests', 'documentation', 'docs', 'component']);
    expect(bashCompletions('completion', '')).toEqual(['bash', 'zsh', 'fish']);
  });

  it('advertises per-command options in zsh', () => {
    const script = completionScript('zsh') ?? '';
    const explainBranch = script.split('\n').find((line) => line.trim().startsWith('explain)')) ?? '';

    expect(script).toContain('#compdef dhruv');
    expect(explainBranch).toContain('--json');
    expect(explainBranch).not.toContain('--strict');
  });

  it('advertises per-command options in fish', () => {
    const explainLines = (completionScript('fish') ?? '').split('\n')
      .filter((line) => line.includes("'__fish_seen_subcommand_from explain'"));

    expect(explainLines.some((line) => line.includes('-l json'))).toBe(true);
    expect(explainLines.some((line) => line.includes('-l strict'))).toBe(false);
  });

  it('rejects unsupported shells', () => {
    expect(completionScript('powershell')).toBeUndefined();
  });
});
