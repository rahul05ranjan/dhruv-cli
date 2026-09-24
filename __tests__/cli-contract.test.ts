import { describe, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Imported only to read Built-in Command facts; the CLI itself runs in a child process.
import { findBuiltInCommand } from '../src/commands/built-in-commands';

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
jest.mock('inquirer', () => ({ __esModule: true, default: { prompt: jest.fn() } }));

const execFileAsync = promisify(execFile);
const repoRoot = resolve(__dirname, '..');
// Package/relative specifiers so Windows does not pass `D:\...` into the ESM loader.
const sourceEntry = './src/index.ts';
const loaderEntry = 'ts-node/esm';

describe('CLI output contract', () => {
  it('keeps shell completion stdout free of startup telemetry', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'completion', 'bash'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toMatch(/^#!\/bin\/bash/);
    expect(result.stdout).not.toContain('Dhruv CLI starting');
    expect(result.stdout).not.toContain('\u001b[');
  });

  it('includes diagnostic commands and shared options in completion scripts', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'completion', 'bash'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('--json');
    const generateTypes = findBuiltInCommand('generate')?.arguments?.[0]?.choices ?? [];
    expect(generateTypes.length).toBeGreaterThan(0);
    expect(result.stdout).toContain(generateTypes.join(' '));
  });

  it('generates valid zsh and fish completion scripts with subcommands', async () => {
    const zshResult = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'completion', 'zsh'],
      { cwd: repoRoot, env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' } },
    );
    expect(zshResult.stdout).toContain('#compdef dhruv');
    expect(zshResult.stdout).toContain('generate');
    expect(zshResult.stdout).not.toContain('\u001b[');

    const fishResult = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'completion', 'fish'],
      { cwd: repoRoot, env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' } },
    );
    expect(fishResult.stdout).toContain('complete -c dhruv');
    expect(fishResult.stdout).toContain('__fish_seen_subcommand_from generate');
    expect(fishResult.stdout).not.toContain('\u001b[');
  });

  it('keeps loading Plugin Commands next to the Built-in Commands', async () => {
    const env = { ...process.env, DHRUV_METRICS_ENABLED: 'false' };
    const help = await execFileAsync(process.execPath, ['--loader', loaderEntry, sourceEntry, '--help'], { cwd: repoRoot, env });
    const run = await execFileAsync(process.execPath, ['--loader', loaderEntry, sourceEntry, 'hello-plugin'], { cwd: repoRoot, env });

    expect(help.stdout).toMatch(/completion \[shell\] +Generate shell completion script\r?\n +hello-plugin +Say hello from a plugin/);
    expect(run.stdout).toContain('Hello from the Dhruv plugin system!');
  });

  it('rejects unsupported completion shells', async () => {
    await expect(execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'completion', 'powershell'],
      { cwd: repoRoot, env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' } },
    )).rejects.toMatchObject({ code: 2 });
  });

  it('documents query commands from their Built-in Command definitions', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'explain', '--help'],
      { cwd: repoRoot, env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' } },
    );

    expect(result.stdout).toContain('Usage: dhruv explain [options] <query>');
    expect(result.stdout).toContain('Explain a concept or command');
    expect(result.stdout).toContain('$ dhruv explain "What is async/await?"');
  });

  it('documents strict security checks in command help', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'security-check', '--help'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toContain('--strict');
  });

  it('documents safe generation controls in command help', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'generate', '--help'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toContain('--apply');
    expect(result.stdout).toContain('--output');
    expect(result.stdout).toContain('--overwrite');
  });

  it('documents explicit metrics export and reset controls', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'metrics', '--help'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toContain('--raw');
    expect(result.stdout).toContain('--reset');
  });

  it('documents detailed health diagnostics as an explicit option', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'health', '--help'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).toContain('--details');
  });

  it('outputs exactly one valid JSON document on stdout with no ANSI or extra text', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--loader', loaderEntry, sourceEntry, 'metrics', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
      },
    );

    expect(result.stdout).not.toContain('\u001b[');
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      command: 'metrics',
    });
  });

  it('outputs valid JSON for health command with expected top-level schema', async () => {
    let stdout: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--loader', loaderEntry, sourceEntry, 'health', '--json'],
        {
          cwd: repoRoot,
          env: { ...process.env, DHRUV_METRICS_ENABLED: 'false' },
        },
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
    expect(parsed.command).toBe('health');
  });

  it('does not persist global flags (--json, --model, --verbose, --timeout) to .dhruv-config.json', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dhruv-session-flags-'));
    const tsNodeLoader = pathToFileURL(resolve(repoRoot, 'node_modules/ts-node/esm.mjs')).href;
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--loader', tsNodeLoader, resolve(repoRoot, sourceEntry), 'metrics', '--json'],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            TS_NODE_PROJECT: resolve(repoRoot, 'tsconfig.json'),
            DHRUV_METRICS_ENABLED: 'false',
          },
        },
      );

      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: true,
        command: 'metrics',
      });

      const localConfigFile = join(tempDir, '.dhruv-config.json');
      expect(existsSync(localConfigFile)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
