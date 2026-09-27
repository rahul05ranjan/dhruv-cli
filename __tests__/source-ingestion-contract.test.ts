import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ingestSource,
  type SourceOutcome,
  type SourceFailureOutcome,
  type SourceSuccessOutcome,
} from '../src/core/source-ingestion';
import {
  presentSourceOutcome,
  TextPresentationAdapter,
  JsonPresentationAdapter,
} from '../src/core/command-presentation';

jest.mock('../src/utils/ux', () => ({
  printError: jest.fn(),
  printInfo: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
}));

describe('Source Ingestion & Presentation Contract', () => {
  let root: string;
  const sourceCommands = ['review', 'security-check', 'optimize', 'generate'] as const;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-contract-test-'));
    process.exitCode = 0;
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  describe('Source Ingestion zero side-effect contract', () => {
    it('ingests a single file without setting exitCode or invoking terminal functions', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      const file = path.join(root, 'index.ts');
      fs.writeFileSync(file, 'export const ready = true;');

      process.exitCode = 0;
      const outcome = ingestSource(file);

      expect(outcome.ok).toBe(true);
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('returns not-found failure without setting exitCode or invoking terminal functions', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      const missing = path.join(root, 'does-not-exist.ts');

      process.exitCode = 0;
      const outcome = ingestSource(missing);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('not-found');
        expect(outcome.target).toBe(missing);
        expect(outcome.message).toContain('does not exist or could not be read');
      }
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('returns no-code-files failure without setting exitCode or invoking terminal functions', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      fs.writeFileSync(path.join(root, 'notes.md'), '# Just markdown');

      process.exitCode = 0;
      const outcome = ingestSource(root);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('no-code-files');
      }
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('caps directory collection at maxFiles without printing notices or mutating process state', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      for (let i = 0; i < 15; i++) {
        fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), `export const v${i} = ${i};`);
      }

      process.exitCode = 0;
      const outcome = ingestSource(root, { maxFiles: 10 });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.capped).toBe(true);
        expect(outcome.files).toHaveLength(10);
      }
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('ingests git diff without setting exitCode or invoking terminal functions', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      execFileSync('git', ['init'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

      const file = path.join(root, 'tracked.ts');
      fs.writeFileSync(file, 'const v = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: root });

      fs.appendFileSync(file, 'const v = 2;\n');

      process.exitCode = 0;
      const outcome = ingestSource(root, { diff: true });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.isDiff).toBe(true);
        expect(outcome.promptContent).toContain('+const v = 2;');
      }
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('returns empty-diff failure without setting exitCode or invoking terminal functions', async () => {
      const { printError, printInfo } = await import('../src/utils/ux');
      execFileSync('git', ['init'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

      const file = path.join(root, 'clean.ts');
      fs.writeFileSync(file, 'const v = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'clean'], { cwd: root });

      process.exitCode = 0;
      const outcome = ingestSource(root, { diff: true });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('empty-diff');
      }
      expect(process.exitCode).toBe(0);
      expect(printError).not.toHaveBeenCalled();
      expect(printInfo).not.toHaveBeenCalled();
    });
  });

  describe('Unified Command Presentation contract for all source-driven commands', () => {
    const failureOutcome: SourceFailureOutcome = {
      ok: false,
      reason: 'not-found',
      target: 'nonexistent.ts',
      message: 'Path "nonexistent.ts" does not exist or could not be read.',
    };

    const cappedOutcome: SourceSuccessOutcome = {
      ok: true,
      target: 'src',
      files: [],
      isDiff: false,
      capped: true,
      promptContent: '',
      maxFiles: 10,
    };

    describe.each(sourceCommands)('Command: %s', (cmd) => {
      it(`renders clear text failure and sets exitCode = 1 for ${cmd}`, async () => {
        const { printError } = await import('../src/utils/ux');
        const textAdapter = new TextPresentationAdapter();

        process.exitCode = 0;
        const result = presentSourceOutcome(cmd, failureOutcome, textAdapter);

        expect(result).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(printError).toHaveBeenCalledWith(failureOutcome.message);
      });

      it(`renders structured JSON failure with zero terminal output and sets exitCode = 1 for ${cmd}`, async () => {
        const { printError } = await import('../src/utils/ux');
        const jsonAdapter = new JsonPresentationAdapter();
        const stdoutChunks: string[] = [];
        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
          stdoutChunks.push(String(chunk));
          return true;
        });

        try {
          process.exitCode = 0;
          const result = presentSourceOutcome(cmd, failureOutcome, jsonAdapter);

          expect(result).toBe(false);
          expect(process.exitCode).toBe(1);
          expect(printError).not.toHaveBeenCalled();

          const raw = stdoutChunks.join('');
          expect(raw).not.toContain('\u001b[');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          expect(parsed).toEqual({
            ok: false,
            command: cmd,
            error: failureOutcome.message,
          });
        } finally {
          stdoutSpy.mockRestore();
        }
      });

      it(`prints directory cap notification in text mode for ${cmd}`, async () => {
        const { printInfo } = await import('../src/utils/ux');
        const textAdapter = new TextPresentationAdapter();

        const result = presentSourceOutcome(cmd, cappedOutcome, textAdapter);

        expect(result).toBe(true);
        expect(printInfo).toHaveBeenCalledWith(`Note: Directory ${cmd} is capped at the first 10 source files.`);
      });

      it(`suppresses directory cap notification in JSON mode for ${cmd}`, async () => {
        const { printInfo } = await import('../src/utils/ux');
        const jsonAdapter = new JsonPresentationAdapter();
        const stdoutChunks: string[] = [];
        const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
          stdoutChunks.push(String(chunk));
          return true;
        });

        try {
          const result = presentSourceOutcome(cmd, cappedOutcome, jsonAdapter);

          expect(result).toBe(true);
          expect(printInfo).not.toHaveBeenCalled();
          expect(stdoutChunks).toHaveLength(0);
        } finally {
          stdoutSpy.mockRestore();
        }
      });
    });
  });
});
