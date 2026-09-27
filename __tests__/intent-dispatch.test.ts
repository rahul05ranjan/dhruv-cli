import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('chalk', () => {
  const identity = (value: unknown) => String(value);
  const makeChalk = (): unknown => new Proxy(identity, {
    get: (_target, property: string | symbol) => property === 'level' ? 0 : makeChalk(),
    apply: (_target, _thisArg, args: unknown[]) => String(args[0]),
  });
  const chalk = makeChalk() as Record<string, unknown>;
  return { __esModule: true, default: chalk, ...chalk };
});
jest.mock('ora', () => ({ __esModule: true, default: jest.fn() }));

import { dispatchRootQuery } from '../src/commands/register-built-in-commands';
import { findBuiltInCommand, type BuiltInCommand } from '../src/commands/built-in-commands';

describe('Root Natural-Language Intent Dispatch', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode !== undefined ? Number(process.exitCode) : undefined;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it('routes and executes the explain command when query confidence is high', async () => {
    const explainCmd = findBuiltInCommand('explain') as BuiltInCommand;
    const runSpy = jest.spyOn(explainCmd, 'run').mockImplementation(() => Promise.resolve());

    await dispatchRootQuery('can you explain how the logger works in this project?', { verbose: true });

    expect(runSpy).toHaveBeenCalledWith(
      { query: 'can you explain how the logger works in this project?' },
      { verbose: true }
    );
  });

  it('routes and executes the review command with the extracted target file', async () => {
    const reviewCmd = findBuiltInCommand('review') as BuiltInCommand;
    const runSpy = jest.spyOn(reviewCmd, 'run').mockImplementation(() => Promise.resolve());

    await dispatchRootQuery('review src/core/logger.ts for potential refactoring', { diff: false });

    expect(runSpy).toHaveBeenCalledWith(
      { fileOrDir: 'src/core/logger.ts' },
      { diff: false }
    );
  });

  it('falls back to interactive menu with query pre-populated when confidence is low in TTY mode', async () => {
    const menuCmd = findBuiltInCommand('menu') as BuiltInCommand;
    const runSpy = jest.spyOn(menuCmd, 'run').mockImplementation(() => Promise.resolve());

    await dispatchRootQuery('asdf qwerty 1234 random', {}, { isTTY: true });

    expect(runSpy).toHaveBeenCalledWith(
      { filter: 'asdf qwerty 1234 random' },
      {}
    );
  });

  it('prints guidance and sets process.exitCode = 1 when confidence is low in non-interactive mode', async () => {
    const ux = await import('../src/utils/ux');
    const errorSpy = jest.spyOn(ux, 'printError').mockImplementation(() => {});

    await dispatchRootQuery('asdf qwerty 1234 random', {}, { isTTY: false });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Low routing confidence'));
    expect(process.exitCode).toBe(1);
  });

  it('wires program root argument action to dispatchRootQuery', async () => {
    const { Command } = await import('commander');
    const { registerBuiltInCommands } = await import('../src/commands/register-built-in-commands');
    const explainCmd = findBuiltInCommand('explain') as BuiltInCommand;
    const runSpy = jest.spyOn(explainCmd, 'run').mockImplementation(() => Promise.resolve());

    const testProgram = new Command();
    registerBuiltInCommands(testProgram);
    await testProgram.parseAsync(['node', 'dhruv', 'how', 'does', 'caching', 'work?']);

    expect(runSpy).toHaveBeenCalledWith(
      { query: 'how does caching work?' },
      expect.anything()
    );
  });
});
