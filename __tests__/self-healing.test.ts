import { describe, expect, it, jest } from '@jest/globals';
import { executeSelfHealingLoop, type CommandExecutor, type PatchGenerator } from '../src/core/self-healing';

describe('Autonomous Self-Healing Loop Coordinator', () => {
  it('terminates immediately on iteration 1 when the initial command succeeds', async () => {
    const mockExecutor: jest.MockedFunction<CommandExecutor> = jest.fn();
    mockExecutor.mockResolvedValue({
      exitCode: 0,
      stdout: 'All 10 tests passed',
      stderr: '',
    });

    const mockPatcher: jest.MockedFunction<PatchGenerator> = jest.fn();

    const result = await executeSelfHealingLoop('npm test', {
      executor: mockExecutor,
      patcher: mockPatcher,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.finalExitCode).toBe(0);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.rolledBack).toBe(false);
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    expect(mockPatcher).not.toHaveBeenCalled();
  });

  it('heals failing command on iteration 2 by applying patch and re-executing', async () => {
    const mockExecutor: jest.MockedFunction<CommandExecutor> = jest.fn();
    mockExecutor
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'FAIL __tests__/app.test.ts\nTypeError: in src/app.ts:15',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'PASS __tests__/app.test.ts',
        stderr: '',
      });

    const fileStore: Record<string, string> = {
      'src/app.ts': 'const x = null; console.log(x.foo);',
    };

    const mockFsAdapter = {
      readFile: jest.fn(async (file: string) => fileStore[file] ?? ''),
      writeFile: jest.fn(async (file: string, content: string) => {
        fileStore[file] = content;
      }),
      fileExists: jest.fn(async (file: string) => file in fileStore),
    };

    const mockPatcher: jest.MockedFunction<PatchGenerator> = jest.fn();
    mockPatcher.mockResolvedValue({
      patches: [
        {
          filePath: 'src/app.ts',
          originalContent: fileStore['src/app.ts'],
          patchedContent: 'const x = { foo: "bar" }; console.log(x.foo);',
        },
      ],
      explanation: 'Initialized object to prevent TypeError',
    });

    const result = await executeSelfHealingLoop('npm test', {
      executor: mockExecutor,
      patcher: mockPatcher,
      fsAdapter: mockFsAdapter,
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.modifiedFiles).toEqual(['src/app.ts']);
    expect(result.finalExitCode).toBe(0);
    expect(result.rolledBack).toBe(false);
    expect(result.explanation).toBe('Initialized object to prevent TypeError');
    expect(mockExecutor).toHaveBeenCalledTimes(2);
    expect(mockPatcher).toHaveBeenCalledTimes(1);
    expect(mockFsAdapter.writeFile).toHaveBeenCalledWith(
      'src/app.ts',
      'const x = { foo: "bar" }; console.log(x.foo);'
    );
  });

  it('automatically rolls back all modified files when max iterations are exceeded', async () => {
    const mockExecutor: jest.MockedFunction<CommandExecutor> = jest.fn();
    mockExecutor.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: persistent test failure',
    });

    const initialContent = 'const original = true;';
    const fileStore: Record<string, string> = {
      'src/app.ts': initialContent,
    };

    const mockFsAdapter = {
      readFile: jest.fn(async (file: string) => fileStore[file] ?? ''),
      writeFile: jest.fn(async (file: string, content: string) => {
        fileStore[file] = content;
      }),
      fileExists: jest.fn(async (file: string) => file in fileStore),
    };

    const mockPatcher: jest.MockedFunction<PatchGenerator> = jest.fn();
    mockPatcher.mockResolvedValue({
      patches: [
        {
          filePath: 'src/app.ts',
          originalContent: initialContent,
          patchedContent: 'const modified = true;',
        },
      ],
      explanation: 'Attempted patch',
    });

    const result = await executeSelfHealingLoop('npm test', {
      maxIterations: 3,
      executor: mockExecutor,
      patcher: mockPatcher,
      fsAdapter: mockFsAdapter,
    });

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.rolledBack).toBe(true);
    expect(result.modifiedFiles).toEqual([]);
    expect(fileStore['src/app.ts']).toBe(initialContent);
    expect(mockExecutor).toHaveBeenCalledTimes(3);
  });

  describe('extractErrorCandidateFiles', () => {
    it('extracts candidate file paths from Jest, TypeScript, and standard stack traces', async () => {
      const { extractErrorCandidateFiles } = await import('../src/core/self-healing');
      const trace = `
        FAIL __tests__/auth.test.ts
          ● Auth › login should succeed
            TypeError: Cannot read properties of undefined (reading 'token')
              at Object.<anonymous> (src/controllers/auth.ts:42:15)
              at processTicksAndRejections (node:internal/process/task_queues:95:5)
      `;

      const existingFiles = new Set(['__tests__/auth.test.ts', 'src/controllers/auth.ts']);
      const mockFs = {
        readFile: jest.fn(async () => ''),
        writeFile: jest.fn(async () => {}),
        fileExists: jest.fn(async (file: string) => existingFiles.has(file)),
      };

      const candidates = await extractErrorCandidateFiles(trace, '', '/repo', mockFs);

      expect(candidates).toContain('src/controllers/auth.ts');
      expect(candidates).toContain('__tests__/auth.test.ts');
      expect(candidates).not.toContain('node:internal/process/task_queues');
    });
  });

  describe('generateSimpleDiff', () => {
    it('produces unified diff format comparing original and patched contents', async () => {
      const { generateSimpleDiff } = await import('../src/core/self-healing');
      const original = 'const a = 1;\nconst b = 2;';
      const patched = 'const a = 1;\nconst b = 3;\nconst c = 4;';

      const diff = generateSimpleDiff('src/index.ts', original, patched);
      expect(diff).toContain('--- a/src/index.ts');
      expect(diff).toContain('+++ b/src/index.ts');
      expect(diff).toContain('- const b = 2;');
      expect(diff).toContain('+ const b = 3;');
      expect(diff).toContain('+ const c = 4;');
    });
  });
});
