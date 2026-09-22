import { describe, expect, it, jest } from '@jest/globals';
import inquirer from 'inquirer';
import { explain } from '../src/commands/explain.js';
import { suggest } from '../src/commands/suggest.js';
import { fix } from '../src/commands/fix.js';
import { menu } from '../src/commands/menu';
import { init } from '../src/commands/init';
import { listModels } from '../src/core/ai';

jest.mock('../src/commands/explain.js', () => ({ explain: jest.fn() }));
jest.mock('../src/commands/suggest.js', () => ({ suggest: jest.fn() }));
jest.mock('../src/commands/fix.js', () => ({ fix: jest.fn() }));

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

  it('uses each query Built-in Command prompt and action from the menu', async () => {
    const prompt = jest.mocked(inquirer.prompt);
    const queryCommands = [
      {
        name: 'explain',
        message: 'What would you like me to explain?',
        query: 'async functions',
        action: jest.mocked(explain),
      },
      {
        name: 'suggest',
        message: 'What would you like suggestions for?',
        query: 'React performance',
        action: jest.mocked(suggest),
      },
      {
        name: 'fix',
        message: 'Describe the issue you need help fixing:',
        query: 'CORS error',
        action: jest.mocked(fix),
      },
    ];

    for (const command of queryCommands) {
      prompt.mockReset();
      command.action.mockReset();
      prompt
        .mockResolvedValueOnce({ filter: '' })
        .mockResolvedValueOnce({ cmd: command.name })
        .mockResolvedValueOnce({ query: command.query })
        .mockResolvedValueOnce({ filter: '' })
        .mockResolvedValueOnce({ cmd: 'exit' });

      await menu();

      const queryPrompt = (prompt.mock.calls[2][0] as unknown as Array<{ message: string }>)[0];
      expect(queryPrompt.message).toBe(command.message);
      expect(command.action).toHaveBeenCalledWith(command.query);
    }

    prompt.mockReset();
    jest.mocked(explain).mockReset();
    jest.mocked(suggest).mockReset();
    jest.mocked(fix).mockReset();
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
});
