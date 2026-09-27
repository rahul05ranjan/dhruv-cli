import { describe, expect, it, jest } from '@jest/globals';
import type { FileSystemAdapter } from '../src/core/self-healing.js';

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

import { findBuiltInCommand } from '../src/commands/built-in-commands';

describe('Built-in Command: run', () => {
  it('is registered with expected arguments and flags', () => {
    const runCmd = findBuiltInCommand('run');
    expect(runCmd).toBeDefined();
    expect(runCmd?.name).toBe('run');
    expect(runCmd?.description).toContain('Execute a shell command');
    expect(runCmd?.arguments?.[0]?.name).toBe('command');

    const flagNames = (runCmd?.options ?? []).map((o) => o.flags);
    expect(flagNames.some((f) => f.includes('--auto-fix'))).toBe(true);
    expect(flagNames.some((f) => f.includes('--apply'))).toBe(true);
    expect(flagNames.some((f) => f.includes('--max-iterations'))).toBe(true);
  });

  describe('run execution behavior', () => {
    it('executes command directly when autoFix is false with json output', async () => {
      const { run } = await import('../src/commands/run.js');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockExecutor = jest.fn(async (_cmd: string, _cwd: string) => ({
        exitCode: 0,
        stdout: 'test output\n',
        stderr: '',
      }));

      await run('npm test', { autoFix: false, json: true }, { executor: mockExecutor });

      expect(mockExecutor).toHaveBeenCalledWith('npm test', expect.any(String));
      expect(logSpy).toHaveBeenCalled();
      const output = JSON.parse(logSpy.mock.calls[0][0]);
      expect(output.ok).toBe(true);
      expect(output.command).toBe('run');
      expect(output.targetCommand).toBe('npm test');
      expect(output.stdout).toBe('test output\n');
      expect(output.exitCode).toBe(0);

      logSpy.mockRestore();
    });

    it('runs self-healing loop autonomously when autoFix is true and apply is true', async () => {
      const { run } = await import('../src/commands/run.js');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      let callCount = 0;
      const mockExecutor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { exitCode: 1, stdout: '', stderr: 'FAIL src/index.ts:1:1' };
        }
        return { exitCode: 0, stdout: 'PASS', stderr: '' };
      });

      const mockPatcher = jest.fn(async () => ({
        patches: [
          {
            filePath: 'src/index.ts',
            originalContent: 'const x = 1;',
            patchedContent: 'const x = 2;',
          },
        ],
        explanation: 'Fixed x value',
      }));

      const files: Record<string, string> = { 'src/index.ts': 'const x = 1;' };
      const mockFsAdapter: FileSystemAdapter = {
        readFile: jest.fn(async (f: string) => files[f] || ''),
        writeFile: jest.fn(async (f: string, c: string) => {
          files[f] = c;
        }),
        fileExists: jest.fn(async (_f: string) => true),
      };

      const prompter = jest.fn(async () => true);

      await run(
        'npm test',
        { autoFix: true, apply: true, json: true },
        {
          executor: mockExecutor,
          patcher: mockPatcher,
          fsAdapter: mockFsAdapter,
          prompter,
          isTTY: true,
        }
      );

      // prompter should NOT be called when --apply is true
      expect(prompter).not.toHaveBeenCalled();
      expect(mockFsAdapter.writeFile).toHaveBeenCalledWith('src/index.ts', 'const x = 2;');
      expect(logSpy).toHaveBeenCalled();
      const output = JSON.parse(logSpy.mock.calls[0][0]);
      expect(output.ok).toBe(true);
      expect(output.iterations).toBe(2);
      expect(output.modifiedFiles).toContain('src/index.ts');
      expect(output.diffs).toBeDefined();

      logSpy.mockRestore();
    });

    it('prompts user confirmation in interactive TTY mode when apply is false', async () => {
      const { run } = await import('../src/commands/run.js');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      let callCount = 0;
      const mockExecutor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { exitCode: 1, stdout: '', stderr: 'FAIL src/index.ts:1:1' };
        }
        return { exitCode: 0, stdout: 'PASS', stderr: '' };
      });

      const mockPatcher = jest.fn(async () => ({
        patches: [
          {
            filePath: 'src/index.ts',
            originalContent: 'const x = 1;',
            patchedContent: 'const x = 2;',
          },
        ],
        explanation: 'Fixed x value',
      }));

      const files: Record<string, string> = { 'src/index.ts': 'const x = 1;' };
      const mockFsAdapter: FileSystemAdapter = {
        readFile: jest.fn(async (f: string) => files[f] || ''),
        writeFile: jest.fn(async (f: string, c: string) => {
          files[f] = c;
        }),
        fileExists: jest.fn(async (_f: string) => true),
      };

      // User rejects the patch
      const prompter = jest.fn(async (_diff: string, _filePath: string) => false);

      await run(
        'npm test',
        { autoFix: true, apply: false, json: true },
        {
          executor: mockExecutor,
          patcher: mockPatcher,
          fsAdapter: mockFsAdapter,
          prompter,
          isTTY: true,
        }
      );

      // Prompter must have been called with diff preview and filePath
      expect(prompter).toHaveBeenCalledWith(expect.stringContaining('src/index.ts'), 'src/index.ts');
      // Rejected, so writeFile was NOT called
      expect(mockFsAdapter.writeFile).not.toHaveBeenCalled();

      logSpy.mockRestore();
    });
  });
});
