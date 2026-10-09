import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from '../src/commands/check';
import { findBuiltInCommand } from '../src/commands/built-in-commands';
import { setAIClient } from '../src/core/ai';
import type { AIClient, AIRequest } from '../src/core/ai';
import { resetSessionConfig, setSessionConfig } from '../src/config/config';
import type { CommittedRangeLimits } from '../src/core/committed-range';
import { securityManager } from '../src/core/security';
import { TempRepo } from './helpers/git-repo';

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

jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    command: jest.fn(),
    performance: jest.fn(),
    security: jest.fn(),
    getSessionId: jest.fn(() => 'test-session'),
    flush: jest.fn(),
  },
  logCommand: jest.fn(),
  logPerformance: jest.fn(),
  logSecurity: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logDebug: jest.fn(),
}));

class FakeClient implements AIClient {
  requests: AIRequest[] = [];

  constructor(private readonly reply: () => string | Promise<string> = () => 'No problems found.') {}

  async ask(request: AIRequest): Promise<string> {
    this.requests.push(request);
    return this.reply();
  }

  async listModels(): Promise<string[]> {
    return ['test-model'];
  }
}

interface JsonResult {
  refs: { base: { commit: string }; head: string };
  coverage: Record<string, unknown>;
  error: { kind: string };
}

/** Runs `check` against a repository and captures what a user or CI job would observe. */
async function runCheck(repo: TempRepo, options: { base?: string }, limits?: Partial<CommittedRangeLimits>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  try {
    await check(options, { cwd: repo.root, limits });
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: process.exitCode ?? 0 };
}

describe('dhruv check --base', () => {
  let repo: TempRepo;
  let client: FakeClient;
  let baseSha: string;

  beforeEach(() => {
    repo = new TempRepo('dhruv-check-');
    baseSha = repo.commit({ 'src/app.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n', 'README.md': '# demo\n' }, 'base');
    repo.git('checkout', '-q', '-b', 'feature');
    client = new FakeClient();
    setAIClient(client);
  });

  afterEach(() => {
    resetSessionConfig();
    repo.remove();
  });

  it('reviews only the committed range and names the resolved commits', async () => {
    const head = repo.commit({ 'src/app.ts': 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\nexport const d = 4;\n' }, 'feature');
    // Staged and unstaged work must not reach the review.
    repo.write('src/staged.ts', 'export const staged = true;\n');
    repo.git('add', 'src/staged.ts');
    repo.write('src/app.ts', 'export const unstagedMarker = 1;\n');

    const result = await runCheck(repo, { base: 'main' });

    expect(result.exitCode).toBe(0);
    expect(client.requests).toHaveLength(1);
    const prompt = client.requests[0].prompt;
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('export const b = 22;');
    expect(prompt).not.toContain('staged');
    expect(prompt).not.toContain('unstagedMarker');
    expect(result.stdout).toContain(baseSha);
    expect(result.stdout).toContain(head);
    expect(result.stdout).toContain('No problems found.');
  });

  it('gives the model new-side changed line numbers', async () => {
    repo.commit({ 'src/app.ts': 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\nexport const d = 4;\n' });

    await runCheck(repo, { base: 'main' });

    const prompt = client.requests[0].prompt;
    expect(prompt).toMatch(/src\/app\.ts[^\n]*changed lines: 2, 4/);
    expect(prompt).toMatch(/^\+\s*2: export const b = 22;$/m);
    expect(prompt).toMatch(/^\+\s*4: export const d = 4;$/m);
  });

  it('diffs from the merge base so later base-branch changes are not reviewed', async () => {
    repo.commit({ 'src/feature.ts': 'export const feature = true;\n' });
    repo.git('checkout', '-q', 'main');
    repo.commit({ 'src/mainonly.ts': 'export const mainOnly = true;\n' }, 'main moves on');
    repo.git('checkout', '-q', 'feature');

    const result = await runCheck(repo, { base: 'main' });

    expect(result.exitCode).toBe(0);
    expect(client.requests[0].prompt).toContain('src/feature.ts');
    expect(client.requests[0].prompt).not.toContain('mainOnly');
    expect(result.stdout).toContain(baseSha);
  });

  it('succeeds without an AI request when the range is clean', async () => {
    const result = await runCheck(repo, { base: 'main' });

    expect(result.exitCode).toBe(0);
    expect(client.requests).toHaveLength(0);
    expect(result.stdout).toMatch(/no changes/i);
  });

  it('fails clearly for an unknown ref without calling the AI', async () => {
    const result = await runCheck(repo, { base: 'no-such-branch' });

    expect(result.exitCode).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect(result.stderr).toContain('no-such-branch');
    expect(result.stdout).toBe('');
  });

  it('rejects refs that look like Git options', async () => {
    const result = await runCheck(repo, { base: '--output=/tmp/dhruv-injected' });

    expect(result.exitCode).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect(fs.existsSync('/tmp/dhruv-injected')).toBe(false);
  });

  it('requires --base', async () => {
    const result = await runCheck(repo, {});

    expect(result.exitCode).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect(result.stderr).toContain('--base');
  });

  it('fails when the base shares no history with HEAD', async () => {
    repo.git('checkout', '-q', '--orphan', 'unrelated');
    repo.commit({ 'other.ts': 'export const other = 1;\n' }, 'unrelated root');

    const result = await runCheck(repo, { base: 'main' });

    expect(result.exitCode).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect(result.stderr).toMatch(/merge base/i);
  });

  it('fails clearly when Git is not available', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(1);
      expect(client.requests).toHaveLength(0);
      expect(result.stderr).toMatch(/git/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('fails when the directory is not a Git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dhruv-check-plain-'));
    const stderr: string[] = [];
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      await check({ base: 'main' }, { cwd: plain });
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toMatch(/not a git repository/i);
    } finally {
      errSpy.mockRestore();
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  describe('Source Ingestion of the range', () => {
    it('follows renames to the new path and reports only the new-side lines', async () => {
      repo.git('mv', 'src/app.ts', 'src/renamed app.ts');
      repo.commit({ 'src/renamed app.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 33;\n' });

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      const prompt = client.requests[0].prompt;
      expect(prompt).toMatch(/src\/renamed app\.ts[^\n]*changed lines: 3/);
      expect(prompt).toContain('renamed from src/app.ts');
    });

    it('excludes deleted files from the prompt and notes them as skipped', async () => {
      repo.git('rm', '-q', 'src/app.ts');
      repo.commit({ 'src/kept.ts': 'export const kept = true;\n' });

      const result = await runCheck(repo, { base: 'main' });

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0].prompt).toContain('src/kept.ts');
      expect(client.requests[0].prompt).not.toContain('export const a = 1;');
      expect(result.stdout).toContain('src/app.ts');
      expect(result.stdout).toMatch(/deleted/);
    });

    it('does not call the AI when only deletions, binaries and unsupported files changed', async () => {
      repo.git('rm', '-q', 'src/app.ts');
      repo.commit({ 'image.ts': Buffer.from([0x00, 0x01, 0x02, 0x00]), 'README.md': '# changed\n' });

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      expect(client.requests).toHaveLength(0);
      expect(result.stdout).toMatch(/binary/);
      expect(result.stdout).toMatch(/unsupported/);
    });

    it('keeps unusual file names intact', async () => {
      repo.commit({ 'src/ünï cödé.ts': 'export const unicode = true;\n' });

      await runCheck(repo, { base: 'main' });

      expect(client.requests[0].prompt).toContain('src/ünï cödé.ts');
    });

    it('applies file-count limits in path order and reports incomplete coverage', async () => {
      repo.commit({ 'src/c.ts': 'export const c = 1;\n', 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });

      const result = await runCheck(repo, { base: 'main' }, { maxChangedFiles: 2 });

      expect(result.exitCode).toBe(0);
      const prompt = client.requests[0].prompt;
      expect(prompt).toContain('src/a.ts');
      expect(prompt).toContain('src/b.ts');
      expect(prompt).not.toContain('src/c.ts');
      expect(result.stdout).toMatch(/incomplete/i);
      expect(result.stdout).toContain('src/c.ts');
    });

    it('skips a file whose patch exceeds the per-file size limit', async () => {
      repo.commit({ 'src/big.ts': `${'export const x = 1;\n'.repeat(200)}`, 'src/small.ts': 'export const s = 1;\n' });

      const result = await runCheck(repo, { base: 'main' }, { maxFileBytes: 500 });

      expect(client.requests[0].prompt).toContain('src/small.ts');
      expect(client.requests[0].prompt).not.toContain('src/big.ts');
      expect(result.stdout).toMatch(/oversized/);
      expect(result.stdout).toMatch(/incomplete/i);
    });

    it('stops adding files once the total prompt budget is spent', async () => {
      repo.commit({ 'src/a.ts': `${'export const a = 1;\n'.repeat(20)}`, 'src/b.ts': `${'export const b = 1;\n'.repeat(20)}` });

      const result = await runCheck(repo, { base: 'main' }, { maxTotalBytes: 700 });

      expect(client.requests[0].prompt).toContain('src/a.ts');
      expect(client.requests[0].prompt).not.toContain('src/b.ts');
      expect(result.stdout).toMatch(/incomplete/i);
    });

    it('is deterministic across runs', async () => {
      repo.commit({ 'src/z.ts': 'export const z = 1;\n', 'src/m.ts': 'export const m = 1;\n' });

      await runCheck(repo, { base: 'main' });
      await runCheck(repo, { base: 'main' });

      expect(client.requests[0].prompt).toBe(client.requests[1].prompt);
    });
  });

  describe('AI outcomes', () => {
    beforeEach(() => {
      repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
    });

    it('fails with a clear message when Ollama is unreachable', async () => {
      setAIClient(new FakeClient(() => { throw { kind: 'connection', cause: 'ECONNREFUSED' }; }));

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/ollama serve/);
      expect(result.stdout).not.toMatch(/No problems/);
    });

    it('fails on an empty model response', async () => {
      setAIClient(new FakeClient(() => '   '));

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(1);
    });

    it('never reports a timeout as success', async () => {
      setAIClient(new FakeClient(() => new Promise<string>(() => undefined)));
      setSessionConfig({ timeoutMs: 20 });

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/timed out/);
    });

    it('exits 130 on cancellation and removes its SIGINT listener', async () => {
      setAIClient(new FakeClient(() => new Promise<string>(() => undefined)));
      setSessionConfig({ timeoutMs: 0 });
      const before = process.listenerCount('SIGINT');
      const stderr: string[] = [];
      const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });

      try {
        const running = check({ base: 'main' }, { cwd: repo.root });
        await new Promise((resolve) => setTimeout(resolve, 50));
        process.emit('SIGINT');
        await running;
        expect(process.exitCode).toBe(130);
        expect(process.listenerCount('SIGINT')).toBe(before);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe('JSON mode', () => {
    it('writes exactly one object to stdout for a reviewed range', async () => {
      setSessionConfig({ responseFormat: 'json', model: 'test-model' });
      const head = repo.commit({ 'src/new.ts': 'export const n = 1;\n' });

      const result = await runCheck(repo, { base: 'main' });

      const parsed = JSON.parse(result.stdout) as JsonResult;
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(parsed).toMatchObject({ schemaVersion: 1, status: 'ok', command: 'check', model: 'test-model' });
      expect(parsed.refs.base.commit).toBe(baseSha);
      expect(parsed.refs.head).toBe(head);
      expect(parsed.coverage).toMatchObject({ changedFiles: 1, analyzedFiles: 1, complete: true });
      expect(JSON.stringify(parsed)).not.toContain('export const n');
    });

    it('writes one error object and a nonzero exit for invalid input', async () => {
      setSessionConfig({ responseFormat: 'json' });

      const result = await runCheck(repo, { base: 'nope' });

      const parsed = JSON.parse(result.stdout) as JsonResult;
      expect(result.exitCode).toBe(1);
      expect(parsed).toMatchObject({ schemaVersion: 1, status: 'error', command: 'check' });
      expect(parsed.error.kind).toBe('unknown-ref');
      expect(client.requests).toHaveLength(0);
    });
  });

  describe('security allowlist', () => {
    it('authorizes a branch name containing words the input filter blocks elsewhere', async () => {
      repo.git('checkout', '-q', '-b', 'fix/format-exec');
      repo.commit({ 'src/new.ts': 'export const n = 1;\n' });

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      expect(client.requests).toHaveLength(1);
    });

    it('allows check, keeps existing commands, and still blocks unknown commands', () => {
      const sha = 'a'.repeat(40);
      expect(securityManager.validateInput('check', { base: sha, head: sha }).valid).toBe(true);
      expect(securityManager.validateInput('check', { base: '--output=x', head: sha }).valid).toBe(false);
      expect(securityManager.validateInput('review', { fileOrDir: 'src' }).valid).toBe(true);
      expect(securityManager.validateInput('security-check', { fileOrDir: 'src' }).valid).toBe(true);
      expect(securityManager.validateInput('not-a-command', {}).error).toBe("Command 'not-a-command' is not allowed");
    });
  });

  it('is runnable from the Built-in Command definition in the current directory', async () => {
    repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
    const originalCwd = process.cwd();
    const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.chdir(repo.root);
    try {
      await findBuiltInCommand('check')!.run({}, { base: 'main' });
      expect(process.exitCode ?? 0).toBe(0);
      expect(client.requests).toHaveLength(1);
    } finally {
      process.chdir(originalCwd);
      outSpy.mockRestore();
    }
  });
});

describe('dhruv check startup', () => {
  const project = path.resolve(__dirname, '..');
  const entry = path.resolve(project, 'src/index.ts');
  const loader = pathToFileURL(path.resolve(project, 'node_modules/ts-node/esm.mjs')).href;

  it('does not execute repository Plugin Commands, even with leading global flags', () => {
    const repo = new TempRepo('dhruv-check-plugin-');
    try {
      repo.commit({ 'plugins/marker.js': 'import { writeFileSync } from "node:fs"; writeFileSync("plugin-executed", "yes");\n' });
      for (const args of [['check', '--base', 'definitely-missing'], ['--json', 'check', '--base', 'definitely-missing']]) {
        const run = spawnSync(process.execPath, ['--loader', loader, entry, ...args], {
          cwd: repo.root,
          encoding: 'utf8',
          env: { ...process.env, TS_NODE_PROJECT: path.resolve(project, 'tsconfig.json'), DHRUV_METRICS_ENABLED: 'false' },
        });
        expect(run.status).toBe(1);
        expect(fs.existsSync(path.join(repo.root, 'plugin-executed'))).toBe(false);
      }
    } finally {
      repo.remove();
    }
  }, 60000);

  it('prints check help without loading plugins', () => {
    const out = execFileSync(process.execPath, ['--loader', loader, entry, 'check', '--help'], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: path.resolve(project, 'tsconfig.json') },
    });
    expect(out).toContain('--base <git-ref>');
  }, 30000);
});
