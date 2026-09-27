import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

import { executeSelfHealingLoop, type PatchGenerator } from '../src/core/self-healing.js';
import { defaultChildProcessExecutor } from '../src/commands/run.js';

describe('Self-Healing End-to-End Contract with Real Child Processes', () => {
  it('executes real child process, diagnoses failure trace, applies patch, and heals to exit 0', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dhruv-contract-heal-'));
    const scriptPath = join(tempDir, 'app.js');

    // Initially failing script
    const buggyCode = `// Buggy code
const value = process.env.TEST_FLAG;
if (value !== 'healed') {
  console.error("FAIL app.js:4:1\\nAssertionError: value is not healed");
  process.exit(1);
}
console.log("PASS All checks passed!");
process.exit(0);
`;
    writeFileSync(scriptPath, buggyCode, 'utf-8');

    const healedCode = buggyCode.replace("process.env.TEST_FLAG;", "'healed';");

    const mockPatcher: PatchGenerator = async (input) => {
      expect(input.exitCode).toBe(1);
      expect(input.stderr).toContain('FAIL app.js:4:1');
      return {
        patches: [
          {
            filePath: 'app.js',
            originalContent: buggyCode,
            patchedContent: healedCode,
          },
        ],
        explanation: 'Assigned healed string constant to value',
      };
    };

    try {
      const result = await executeSelfHealingLoop('node app.js', {
        cwd: tempDir,
        maxIterations: 3,
        executor: defaultChildProcessExecutor,
        patcher: mockPatcher,
      });

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);
      expect(result.finalExitCode).toBe(0);
      expect(result.modifiedFiles).toContain('app.js');
      expect(result.rolledBack).toBe(false);

      // Verify the file on disk was genuinely mutated to the healed code
      const currentContent = readFileSync(scriptPath, 'utf-8');
      expect(currentContent).toBe(healedCode);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('performs atomic rollback on real disk when the command persistently fails across all iterations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dhruv-contract-rollback-'));
    const scriptPath = join(tempDir, 'fail.js');

    const initialContent = `// Initial persistent failure
console.error("FAIL fail.js:2:1\\nUnrecoverable persistent error");
process.exit(2);
`;
    writeFileSync(scriptPath, initialContent, 'utf-8');

    let patchAttempts = 0;
    const mockPatcher: PatchGenerator = async () => {
      patchAttempts++;
      return {
        patches: [
          {
            filePath: 'fail.js',
            originalContent: initialContent,
            patchedContent: `// Mutation attempt ${patchAttempts}\nconsole.error("FAIL fail.js:2:1\\nStill failing");\nprocess.exit(2);`,
          },
        ],
        explanation: `Attempted patch ${patchAttempts}`,
      };
    };

    try {
      const result = await executeSelfHealingLoop('node fail.js', {
        cwd: tempDir,
        maxIterations: 3,
        executor: defaultChildProcessExecutor,
        patcher: mockPatcher,
      });

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(3);
      expect(result.finalExitCode).toBe(2);
      expect(result.rolledBack).toBe(true);
      expect(result.modifiedFiles).toEqual([]);

      // Verify that after rollback, the file on disk is restored to its exact initial state
      const diskContent = readFileSync(scriptPath, 'utf-8');
      expect(diskContent).toBe(initialContent);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
