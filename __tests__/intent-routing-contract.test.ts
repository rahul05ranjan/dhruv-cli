import { describe, expect, it } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(__dirname, '..');
const sourceEntry = './src/index.ts';
const loaderEntry = 'ts-node/esm';

describe('Intent Routing End-to-End Contract', () => {
  it('exits with code 1 and outputs guidance when low-confidence query is run non-interactively', async () => {
    try {
      await execFileAsync(
        process.execPath,
        ['--loader', loaderEntry, sourceEntry, 'random unknown query 12345'],
        {
          cwd: repoRoot,
          env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
        }
      );
      throw new Error('Expected process to fail');
    } catch (err: unknown) {
      const execError = err as { code?: number; stderr?: string; stdout?: string };
      expect(execError.code).toBe(1);
      const combinedOutput = (execError.stderr ?? '') + (execError.stdout ?? '');
      expect(combinedOutput).toContain('Low routing confidence');
    }
  });

  it('routes natural-language security check query to security-check command and inspects directory', async () => {
    let stdout: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--loader', loaderEntry, sourceEntry, 'audit security vulnerabilities in src/config', '--json'],
        {
          cwd: repoRoot,
          env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
        }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const execError = err as { stdout?: string; code?: number };
      if (typeof execError?.stdout === 'string' && execError.stdout.trim().length > 0) {
        stdout = execError.stdout;
      } else {
        throw err;
      }
    }

    expect(stdout).not.toContain('\u001b[');
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok');
    expect(parsed.command).toBe('security-check');
  });

  it('outputs valid JSON format when --json option is passed to routed command', async () => {
    let stdout: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--loader', loaderEntry, sourceEntry, 'review src/config/config.ts', '--json'],
        {
          cwd: repoRoot,
          env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
        }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const execError = err as { stdout?: string; code?: number };
      if (typeof execError?.stdout === 'string' && execError.stdout.trim().length > 0) {
        stdout = execError.stdout;
      } else {
        throw err;
      }
    }

    expect(stdout).not.toContain('\u001b[');
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok');
    expect(parsed.command).toBe('review');
  });
});
