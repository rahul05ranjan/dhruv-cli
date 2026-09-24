import { describe, expect, it, jest } from '@jest/globals';
import inquirer from 'inquirer';
import { menu } from '../src/commands/menu';
import { init } from '../src/commands/init';
import { listModels } from '../src/core/ai';
import { explain } from '../src/commands/explain';
import { suggest } from '../src/commands/suggest';
import { fix } from '../src/commands/fix';
import { review } from '../src/commands/review';
import { optimize } from '../src/commands/optimize';
import { securityCheck } from '../src/commands/security-check';
import { generate } from '../src/commands/generate';
import { status } from '../src/commands/status';
import { health } from '../src/commands/health';
import { metrics } from '../src/commands/metrics';
import { themed } from '../src/utils/ux';
import { findBuiltInCommand } from '../src/commands/built-in-commands';

const generateTypes = () => findBuiltInCommand('generate')?.arguments?.[0]?.choices ?? [];

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
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
  })),
}));

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

jest.mock('../src/core/ai', () => ({
  listModels: jest.fn(),
}));

jest.mock('../src/commands/explain', () => ({ explain: jest.fn() }));
jest.mock('../src/commands/suggest', () => ({ suggest: jest.fn() }));
jest.mock('../src/commands/fix', () => ({ fix: jest.fn() }));
jest.mock('../src/commands/review', () => ({ review: jest.fn() }));
jest.mock('../src/commands/optimize', () => ({ optimize: jest.fn() }));
jest.mock('../src/commands/security-check', () => ({ securityCheck: jest.fn() }));
jest.mock('../src/commands/generate', () => ({ generate: jest.fn() }));
jest.mock('../src/commands/status', () => ({ status: jest.fn() }));
jest.mock('../src/commands/health', () => ({ health: jest.fn() }));
jest.mock('../src/commands/metrics', () => ({ metrics: jest.fn() }));
// The init tests above need the real wizard; menu dispatch replaces it once per test.
jest.mock('../src/commands/init', () => {
  const actual = jest.requireActual<typeof import('../src/commands/init')>('../src/commands/init');
  return { init: jest.fn(actual.init) };
});

jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

describe('interactive commands', () => {
  it('handles menu cancellation without an unhandled rejection', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockRejectedValueOnce(new Error('User force closed the prompt with 0 null'));
    process.exitCode = undefined;

    try {
      await menu();
      expect(process.exitCode).toBe(130);
    } finally {
      prompt.mockReset();
      process.exitCode = undefined;
    }
  });

  it('handles init cancellation with a cancellation exit code', async () => {
    jest.mocked(listModels).mockResolvedValue(['test-model']);
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockRejectedValueOnce(new Error('User force closed the prompt with 0 null'));
    process.exitCode = undefined;

    try {
      await init();
      expect(process.exitCode).toBe(130);
    } finally {
      prompt.mockReset();
      process.exitCode = undefined;
    }
  });

  it('handles init non-interactive TTY failure with failure exit code', async () => {
    jest.mocked(listModels).mockResolvedValue(['test-model']);
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockRejectedValueOnce({ isTtyError: true, message: 'TTY required' });
    process.exitCode = undefined;

    try {
      await init();
      expect(process.exitCode).toBe(1);
    } finally {
      prompt.mockReset();
      process.exitCode = undefined;
    }
  });

  it('asks whether init should save project-local or user-global settings', async () => {
    jest.mocked(listModels).mockResolvedValue(['test-model']);
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockResolvedValueOnce({
      model: 'test-model',
      responseFormat: 'text',
      verbose: false,
      theme: 'default',
      scope: 'local',
    });

    await init();

    const questions = prompt.mock.calls[0][0] as unknown as Array<{ name: string; choices?: string[] }>;
    expect(questions.find((question) => question.name === 'scope')?.choices).toEqual(['local', 'global']);
    prompt.mockReset();
  });

  it('offers diagnostic commands from the interactive menu', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockResolvedValueOnce({ filter: '' }).mockResolvedValueOnce({ cmd: 'exit' });

    await menu();

    const choices = (prompt.mock.calls[1][0] as unknown as Array<{ choices: Array<{ value: string }> }>)[0].choices;
    expect(choices.map(choice => choice.value)).toEqual(expect.arrayContaining([
      'status',
      'health',
      'metrics',
      'completion',
    ]));
  });

  it('offers command filtering before opening the menu', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockRejectedValueOnce(new Error('User force closed the prompt with 0 null'));

    await menu();

    expect((prompt.mock.calls[0][0] as unknown as Array<{ name: string; type: string }>)[0]).toMatchObject({
      name: 'filter',
      type: 'input',
    });
  });

  it.each([
    { name: 'explain', label: 'Explain', message: 'What would you like me to explain?', action: explain },
    { name: 'suggest', label: 'Suggest', message: 'What would you like suggestions for?', action: suggest },
    { name: 'fix', label: 'Fix', message: 'Describe the issue you need help fixing:', action: fix },
  ])('runs $name from the menu with the prompted query', async ({ name, label, message, action }) => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    jest.mocked(action).mockClear();
    prompt
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: name })
      .mockResolvedValueOnce({ query: 'closures' })
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: 'exit' });

    try {
      await menu();

      const choices = (prompt.mock.calls[1][0] as unknown as Array<{ choices: Array<{ name: string; value: string }> }>)[0].choices;
      expect(choices).toContainEqual({ name: label, value: name });
      expect((prompt.mock.calls[2][0] as unknown as Array<{ name: string; message: string }>)[0]).toMatchObject({ name: 'query', message });
      expect(action).toHaveBeenCalledWith('closures');
    } finally {
      prompt.mockReset();
    }
  });

  it('skips a query command when the menu query is empty', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    jest.mocked(explain).mockClear();
    prompt
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: 'explain' })
      .mockResolvedValueOnce({ query: '' })
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: 'exit' });

    try {
      await menu();
      expect(explain).not.toHaveBeenCalled();
    } finally {
      prompt.mockReset();
    }
  });

  type MenuQuestion = { name: string; type: string; message: string; default?: string; choices?: string[] };

  /** Runs the menu once for `cmd`, answering its argument prompt with `answers`, then exits. */
  async function runMenuCommand(cmd: string, answers: Record<string, string>): Promise<{ label?: string; questions: MenuQuestion[] }> {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    prompt
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd })
      .mockResolvedValueOnce(answers)
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: 'exit' });
    try {
      await menu();
      const choices = (prompt.mock.calls[1][0] as unknown as Array<{ choices: Array<{ name: string; value: string }> }>)[0].choices;
      return {
        label: choices.find((choice) => choice.value === cmd)?.name,
        questions: prompt.mock.calls[2][0] as unknown as MenuQuestion[],
      };
    } finally {
      prompt.mockReset();
    }
  }

  /** Selects one menu entry, then exits the menu. */
  async function selectFromMenu(name: string): Promise<void> {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    prompt
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: name })
      .mockResolvedValueOnce({ filter: '' })
      .mockResolvedValueOnce({ cmd: 'exit' });
    try {
      await menu();
    } finally {
      prompt.mockReset();
    }
  }

  it.each([
    { name: 'init', label: 'Init (Setup)', action: init },
    { name: 'status', label: 'Status', action: status },
    { name: 'health', label: 'Health Check', action: health },
    { name: 'metrics', label: 'Metrics', action: metrics },
  ])('runs $name from the menu without asking for input', async ({ name, action }) => {
    const mocked = jest.mocked(action as () => Promise<void>);
    mocked.mockClear();
    mocked.mockResolvedValueOnce(undefined);

    await selectFromMenu(name);

    expect(mocked).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('offers setup and diagnostic commands under their menu labels', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    prompt.mockReset();
    prompt.mockResolvedValueOnce({ filter: '' }).mockResolvedValueOnce({ cmd: 'exit' });

    await menu();

    const choices = (prompt.mock.calls[1][0] as unknown as Array<{ choices: Array<{ name: string; value: string }> }>)[0].choices;
    expect(choices).toEqual(expect.arrayContaining([
      { name: 'Init (Setup)', value: 'init' },
      { name: 'Status', value: 'status' },
      { name: 'Health Check', value: 'health' },
      { name: 'Metrics', value: 'metrics' },
      { name: 'Project Type', value: 'project-type' },
      { name: 'Menu', value: 'menu' },
      { name: 'Shell Completion', value: 'completion' },
    ]));
    prompt.mockReset();
  });

  it('prints the detected project type from the menu', async () => {
    jest.mocked(console.log).mockClear();

    await selectFromMenu('project-type');

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^Detected project type: \S+$/));
  });

  it.each([
    { name: 'completion', hint: 'Run `dhruv completion <bash|zsh|fish>` to install shell completion.' },
    { name: 'menu', hint: 'You selected: menu' },
  ])('prints a hint instead of running $name from the menu', async ({ name, hint }) => {
    jest.mocked(console.log).mockClear();

    await selectFromMenu(name);

    expect(themed).toHaveBeenCalledWith(hint, 'accent');
    expect(console.log).toHaveBeenCalledWith(hint);
  });

  it.each([
    { name: 'review', label: 'Review', argument: 'fileOrDir', message: 'Enter file or directory path to review:', action: review },
    { name: 'optimize', label: 'Optimize', argument: 'file', message: 'Enter file path to optimize:', action: optimize },
  ])('runs $name from the menu with the prompted path', async ({ name, label, argument, message, action }) => {
    jest.mocked(action).mockClear();

    const menuRun = await runMenuCommand(name, { [argument]: 'src/app.ts' });

    expect(menuRun.label).toBe(label);
    expect(menuRun.questions).toEqual([expect.objectContaining({ type: 'input', name: argument, message })]);
    expect(action).toHaveBeenCalledWith('src/app.ts', ...(name === 'review' ? [{}] : []));
  });

  it.each([
    { name: 'review', argument: 'fileOrDir', action: review },
    { name: 'optimize', argument: 'file', action: optimize },
  ])('skips $name when the menu path is empty', async ({ name, argument, action }) => {
    jest.mocked(action).mockClear();

    await runMenuCommand(name, { [argument]: '' });

    expect(action).not.toHaveBeenCalled();
  });

  it('runs security-check from the menu, defaulting to the current directory', async () => {
    jest.mocked(securityCheck).mockClear();

    const menuRun = await runMenuCommand('security-check', { fileOrDir: '.' });

    expect(menuRun.label).toBe('Security Check');
    expect(menuRun.questions).toEqual([expect.objectContaining({
      type: 'input',
      name: 'fileOrDir',
      message: 'Enter file or directory path to check (or press enter for current directory):',
      default: '.',
    })]);
    expect(securityCheck).toHaveBeenCalledWith('.', {});
  });

  it('runs generate from the menu with the chosen type and target', async () => {
    jest.mocked(generate).mockClear();

    const menuRun = await runMenuCommand('generate', { type: 'docs', target: 'src/app.ts' });

    expect(menuRun.label).toBe('Generate');
    expect(menuRun.questions).toEqual([
      expect.objectContaining({ type: 'list', name: 'type', message: 'What would you like to generate?', choices: [...generateTypes()] }),
      expect.objectContaining({ type: 'input', name: 'target', message: 'Enter target file path:' }),
    ]);
    expect(generate).toHaveBeenCalledWith('docs', 'src/app.ts', {});
  });

  it('skips generate when the menu target is empty', async () => {
    jest.mocked(generate).mockClear();

    await runMenuCommand('generate', { type: 'tests', target: '' });

    expect(generate).not.toHaveBeenCalled();
  });
});
