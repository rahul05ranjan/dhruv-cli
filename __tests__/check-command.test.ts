import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from '../src/commands/check';
import { findBuiltInCommand } from '../src/commands/built-in-commands';
import type { Ollama } from 'ollama';
import { OllamaAIClient, setAIClient } from '../src/core/ai';
import type { AIClient, AIRequest } from '../src/core/ai';
import * as loggerModule from '../src/core/logger';
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

  constructor(private readonly reply: () => string | Promise<string> = () => findingsReply([])) {}

  async ask(request: AIRequest): Promise<string> {
    this.requests.push(request);
    return this.reply();
  }

  async listModels(): Promise<string[]> {
    return ['test-model'];
  }
}

interface JsonFinding {
  path: string;
  line: number;
  severity: string;
  reason: string;
  evidence: string;
  recommendation: string;
}

interface JsonResult {
  status: string;
  refs: { base: { ref: string; commit: string }; mergeBase: string; head: string };
  model: string;
  findings: JsonFinding[];
  summary: { findings: number; bySeverity: Record<string, number>; candidates: number; omitted: { invalid: number; offDiff: number; duplicate: number } };
  coverage: Record<string, unknown>;
  exclusions: Array<{ path: string; reason: string }>;
  error: { kind: string; message: string; hint?: string };
}

/** A model response carrying candidate findings. */
function findingsReply(findings: unknown[]): string {
  return JSON.stringify({ findings });
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/app.ts',
    line: 2,
    severity: 'high',
    reason: 'Constant changed without updating callers',
    evidence: 'b is now 22 while callers still assume 2',
    recommendation: 'Update the callers or keep the previous value',
    ...overrides,
  };
}

/** Everything the mocked logger and console were asked to record. */
function recordedTelemetry(): string {
  const sinks: unknown[] = [...Object.values(loggerModule.logger), ...Object.values(loggerModule), console.log, console.warn, console.error];
  return JSON.stringify(sinks.filter((sink) => jest.isMockFunction(sink)).flatMap((sink) => (sink as jest.Mock).mock.calls));
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
    expect(result.stdout).toMatch(/no findings/i);
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
      expect(result.stdout).toBe('');
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

  describe('findings', () => {
    const useReply = (reply: string) => {
      client = new FakeClient(() => reply);
      setAIClient(client);
    };
    const jsonCheck = async (): Promise<JsonResult> => {
      setSessionConfig({ responseFormat: 'json', model: 'test-model' });
      const result = await runCheck(repo, { base: 'main' });
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      return JSON.parse(result.stdout) as JsonResult;
    };

    beforeEach(() => {
      // Changes lines 2 and 4 of src/app.ts; lines 1 and 3 are unchanged context.
      repo.git('rm', '-q', 'README.md');
      repo.commit({
        'src/app.ts': 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\nexport const d = 4;\n',
        'src/extra.ts': 'export const extra = true;\n',
      }, 'feature');
    });

    it('reports a grounded finding with its location, severity, reason, evidence and recommendation', async () => {
      useReply(findingsReply([candidate({ severity: 'critical' })]));

      const text = await runCheck(repo, { base: 'main' });
      const parsed = await jsonCheck();

      expect(parsed.findings).toEqual([{
        path: 'src/app.ts',
        line: 2,
        severity: 'critical',
        reason: 'Constant changed without updating callers',
        evidence: 'b is now 22 while callers still assume 2',
        recommendation: 'Update the callers or keep the previous value',
      }]);
      expect(parsed.summary).toMatchObject({ findings: 1, candidates: 1, omitted: { invalid: 0, offDiff: 0, duplicate: 0 } });
      expect(parsed.summary.bySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 });
      // Findings are advisory: even a critical one leaves the run successful.
      expect(parsed.status).toBe('ok');
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain('src/app.ts:2');
      expect(text.stdout).toMatch(/critical/i);
      expect(text.stdout).toContain('Constant changed without updating callers');
      expect(text.stdout).toContain('b is now 22 while callers still assume 2');
      expect(text.stdout).toContain('Update the callers or keep the previous value');
      expect(text.stdout).toMatch(/1 finding\b/);
      expect(text.stderr).toBe('');
    });

    it('accepts a response that wraps the JSON object in a code fence', async () => {
      useReply(`Here is the review:\n\`\`\`json\n${findingsReply([candidate()])}\n\`\`\`\n`);

      const parsed = await jsonCheck();

      expect(parsed.status).toBe('ok');
      expect(parsed.findings).toHaveLength(1);
    });

    it('normalizes paths, line numbers and severities before validating them', async () => {
      useReply(findingsReply([candidate({ path: './src/app.ts', line: '4', severity: ' High ' })]));

      const parsed = await jsonCheck();

      expect(parsed.findings).toMatchObject([{ path: 'src/app.ts', line: 4, severity: 'high' }]);
    });

    it.each([
      ['plain prose', 'The change looks fine to me. RAW_RESPONSE_MARKER'],
      ['broken JSON', '{"findings": [ RAW_RESPONSE_MARKER'],
      ['an object without a findings collection', '{"issues": [], "note": "RAW_RESPONSE_MARKER"}'],
      ['a findings value that is not a collection', '{"findings": "RAW_RESPONSE_MARKER"}'],
      ['a bare array', `[${JSON.stringify(candidate({ reason: 'RAW_RESPONSE_MARKER' }))}]`],
    ])('fails the run when the model returns %s', async (_label, reply) => {
      useReply(reply);

      const text = await runCheck(repo, { base: 'main' });
      const parsed = await jsonCheck();

      expect(text.exitCode).toBe(1);
      expect(text.stdout).toBe('');
      expect(text.stderr).toMatch(/model/i);
      expect(process.exitCode).toBe(1);
      expect(parsed.status).toBe('error');
      expect(parsed.error.kind).toBe('invalid-response');
      expect(parsed).not.toHaveProperty('findings');
      expect(parsed.model).toBe('test-model');
      // The raw response is never echoed to the user, the result or the logs.
      expect(text.stderr).not.toContain('RAW_RESPONSE_MARKER');
      expect(JSON.stringify(parsed)).not.toContain('RAW_RESPONSE_MARKER');
      expect(recordedTelemetry()).not.toContain('RAW_RESPONSE_MARKER');
    });

    it('omits and counts malformed candidates while keeping the valid ones', async () => {
      useReply(findingsReply([
        candidate({ line: 4, reason: 'Kept' }),
        candidate({ reason: undefined }),
        candidate({ reason: '   ' }),
        candidate({ recommendation: undefined }),
        candidate({ evidence: undefined }),
        candidate({ severity: 'blocker' }),
        candidate({ severity: undefined }),
        candidate({ line: 2.5 }),
        candidate({ line: 'two' }),
        candidate({ path: 42 }),
        'not an object',
        null,
      ]));

      const text = await runCheck(repo, { base: 'main' });
      const parsed = await jsonCheck();

      expect(parsed.status).toBe('ok');
      expect(parsed.findings).toMatchObject([{ path: 'src/app.ts', line: 4, reason: 'Kept' }]);
      expect(parsed.summary).toMatchObject({ findings: 1, candidates: 12, omitted: { invalid: 11, offDiff: 0, duplicate: 0 } });
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toMatch(/11 invalid/);
    });

    it('omits and counts candidates that do not point at a changed line of an analyzed file', async () => {
      useReply(findingsReply([
        candidate({ line: 2, reason: 'Kept' }),
        candidate({ line: 1, reason: 'Unchanged context line' }),
        candidate({ line: 3, reason: 'Unchanged context line' }),
        candidate({ line: 99, reason: 'Beyond the file' }),
        candidate({ line: 0, reason: 'No such line' }),
        candidate({ path: 'src/missing.ts', reason: 'Unknown file' }),
        candidate({ path: 'README.md', line: 1, reason: 'Deleted file' }),
        candidate({ path: '../src/app.ts', reason: 'Outside the repository' }),
        candidate({ path: `${repo.root}/src/app.ts`, reason: 'Absolute path' }),
      ]));

      const text = await runCheck(repo, { base: 'main' });
      const parsed = await jsonCheck();

      expect(parsed.findings).toMatchObject([{ path: 'src/app.ts', line: 2, reason: 'Kept' }]);
      expect(parsed.summary).toMatchObject({ findings: 1, candidates: 9, omitted: { invalid: 0, offDiff: 8, duplicate: 0 } });
      expect(text.stdout).not.toContain('Unknown file');
      expect(text.stdout).not.toContain('Unchanged context line');
      expect(text.stdout).toMatch(/8 not on a changed line/);
    });

    it('collapses duplicates deterministically, keeping the most severe', async () => {
      const candidates = [
        candidate({ severity: 'low', reason: 'Unused constant.' }),
        candidate({ severity: 'high', reason: '  unused   CONSTANT', evidence: 'kept evidence' }),
        candidate({ severity: 'medium', reason: 'Unused constant!' }),
        candidate({ line: 4, reason: 'Unused constant' }),
        candidate({ path: 'src/extra.ts', line: 1, reason: 'Unused constant' }),
        candidate({ reason: 'A different problem' }),
      ];

      useReply(findingsReply(candidates));
      const forward = await jsonCheck();
      useReply(findingsReply([...candidates].reverse()));
      const backward = await jsonCheck();

      expect(forward.findings.map(({ path, line, severity, reason }) => `${path}:${line} ${severity} ${reason}`)).toEqual([
        'src/app.ts:2 high A different problem',
        'src/app.ts:2 high unused CONSTANT',
        'src/app.ts:4 high Unused constant',
        'src/extra.ts:1 high Unused constant',
      ]);
      expect(forward.findings[1].evidence).toBe('kept evidence');
      expect(forward.summary).toMatchObject({ findings: 4, candidates: 6, omitted: { invalid: 0, offDiff: 0, duplicate: 2 } });
      expect(backward.findings).toEqual(forward.findings);
      expect(backward.summary).toEqual(forward.summary);
    });

    it('orders findings by path, line and severity whatever order the model used', async () => {
      useReply(findingsReply([
        candidate({ path: 'src/extra.ts', line: 1, severity: 'critical', reason: 'Third' }),
        candidate({ line: 4, severity: 'critical', reason: 'Second' }),
        candidate({ line: 2, severity: 'info', reason: 'First, less severe' }),
        candidate({ line: 2, severity: 'medium', reason: 'First' }),
      ]));

      const parsed = await jsonCheck();

      expect(parsed.findings.map(({ reason }) => reason)).toEqual(['First', 'First, less severe', 'Second', 'Third']);
      expect(parsed.summary.bySeverity).toEqual({ critical: 2, high: 0, medium: 1, low: 0, info: 1 });
    });

    it('summarizes findings, omissions and coverage in text', async () => {
      useReply(findingsReply([
        candidate({ severity: 'high' }),
        candidate({ line: 4, severity: 'low', reason: 'Magic number' }),
        candidate({ line: 4, severity: 'low', reason: 'magic number' }),
        candidate({ line: 3, reason: 'Off the diff' }),
        candidate({ severity: 'unknown' }),
      ]));

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Analyzed 2 of 3 changed files/);
      expect(result.stdout).toMatch(/2 findings: 1 high, 1 low/);
      expect(result.stdout).toMatch(/1 invalid/);
      expect(result.stdout).toMatch(/1 not on a changed line/);
      expect(result.stdout).toMatch(/1 duplicate/);
      expect(result.stdout).toMatch(/README\.md\s+\(deleted\)/);
      expect(result.stdout.indexOf('src/app.ts:2')).toBeLessThan(result.stdout.indexOf('src/app.ts:4'));
    });

    it('says so plainly when the model reports nothing', async () => {
      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/No findings\./);
      expect(result.stdout).not.toMatch(/omitted|duplicate/i);
    });

    it('strips terminal control sequences and line breaks from model text', async () => {
      useReply(findingsReply([candidate({ reason: 'Bad\u001b[31m value\nsecond line', evidence: 'tab\there\r\n', recommendation: `${'x'.repeat(5000)}` })]));

      const text = await runCheck(repo, { base: 'main' });
      const parsed = await jsonCheck();

      expect(text.stdout).not.toContain('\u001b');
      expect(parsed.findings[0].reason).toBe('Bad [31m value second line');
      expect(parsed.findings[0].evidence).toBe('tab here');
      expect(parsed.findings[0].recommendation.length).toBeLessThan(1000);
    });
  });

  describe('JSON result', () => {
    beforeEach(() => {
      setSessionConfig({ responseFormat: 'json', model: 'test-model' });
    });

    const expectSingleObject = (stdout: string): JsonResult => {
      expect(stdout.endsWith('\n')).toBe(true);
      expect(stdout.trim().split('\n')).toHaveLength(1);
      return JSON.parse(stdout) as JsonResult;
    };

    it('carries model, resolved commits, findings, coverage and exclusions and nothing incidental', async () => {
      repo.git('rm', '-q', 'README.md');
      const head = repo.commit({ 'src/app.ts': 'export const a = 1;\nexport const SOURCE_MARKER = 22;\nexport const c = 3;\n' });
      setAIClient(new FakeClient(() => findingsReply([candidate()])));

      const result = await runCheck(repo, { base: 'main' });

      const parsed = expectSingleObject(result.stdout);
      expect(Object.keys(parsed).sort()).toEqual(['command', 'coverage', 'exclusions', 'findings', 'model', 'refs', 'schemaVersion', 'status', 'summary']);
      expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'ok', model: 'test-model' });
      expect(parsed.refs).toEqual({ base: { ref: 'main', commit: baseSha }, mergeBase: baseSha, head });
      expect(parsed.coverage).toEqual({ changedFiles: 2, analyzedFiles: 1, skippedFiles: 1, complete: true });
      expect(parsed.exclusions).toEqual([{ path: 'README.md', reason: 'deleted' }]);
      expect(parsed.findings).toHaveLength(1);
      // No patch, banner or diagnostics: stdout is the object and stderr stays quiet.
      expect(result.stdout).not.toContain('SOURCE_MARKER');
      expect(result.stdout).not.toContain('@@');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('reports a clean range as a successful empty result', async () => {
      const result = await runCheck(repo, { base: 'main' });

      const parsed = expectSingleObject(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(client.requests).toHaveLength(0);
      expect(parsed).toMatchObject({ status: 'ok', findings: [], exclusions: [], summary: { findings: 0, candidates: 0 } });
      expect(parsed.coverage).toMatchObject({ changedFiles: 0, complete: true });
    });

    it('reports an unreachable AI as an error with the commits and model it was reviewing', async () => {
      const head = repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
      setAIClient(new FakeClient(() => { throw { kind: 'connection', cause: 'ECONNREFUSED' }; }));

      const result = await runCheck(repo, { base: 'main' });

      const parsed = expectSingleObject(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'error', model: 'test-model' });
      expect(parsed.error.kind).toBe('ai-connection');
      expect(parsed.error.hint).toMatch(/ollama serve/);
      expect(parsed.refs.head).toBe(head);
      expect(parsed.coverage).toMatchObject({ changedFiles: 1, analyzedFiles: 1 });
      expect(parsed).not.toHaveProperty('findings');
      expect(result.stderr).toBe('');
    });

    it('reports a timeout as an error, never as success', async () => {
      repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
      setAIClient(new FakeClient(() => new Promise<string>(() => undefined)));
      setSessionConfig({ timeoutMs: 20 });

      const result = await runCheck(repo, { base: 'main' });

      const parsed = expectSingleObject(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(parsed.status).toBe('error');
      expect(parsed.error.kind).toBe('ai-timeout');
      expect(parsed).not.toHaveProperty('findings');
    });

    it('reports cancellation with its own status and exit code', async () => {
      repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
      setAIClient(new FakeClient(() => new Promise<string>(() => undefined)));
      setSessionConfig({ timeoutMs: 0 });
      const stdout: string[] = [];
      const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });

      try {
        const running = check({ base: 'main' }, { cwd: repo.root });
        await new Promise((resolve) => setTimeout(resolve, 50));
        process.emit('SIGINT');
        await running;
      } finally {
        outSpy.mockRestore();
      }

      const parsed = expectSingleObject(stdout.join(''));
      expect(process.exitCode).toBe(130);
      expect(parsed.status).toBe('cancelled');
      expect(parsed.error.kind).toBe('ai-cancelled');
      expect(parsed).not.toHaveProperty('findings');
    });

    it('reports a missing --base as an error object', async () => {
      const result = await runCheck(repo, {});

      const parsed = expectSingleObject(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'error' });
      expect(parsed.error.kind).toBe('invalid-input');
      expect(client.requests).toHaveLength(0);
    });
  });

  describe('telemetry', () => {
    it('records neither the prompt nor the model response', async () => {
      repo.commit({ 'src/app.ts': 'export const a = 1;\nexport const SOURCE_MARKER = 22;\nexport const c = 3;\n' });
      setAIClient(new FakeClient(() => JSON.stringify({ findings: [candidate()], note: 'RESPONSE_MARKER' })));

      const result = await runCheck(repo, { base: 'main' });

      expect(result.exitCode).toBe(0);
      const recorded = recordedTelemetry();
      expect(recorded).not.toContain('SOURCE_MARKER');
      expect(recorded).not.toContain('RESPONSE_MARKER');
      expect(result.stdout).not.toContain('SOURCE_MARKER');
      expect(result.stderr).toBe('');
    });

    it('does not keep model responses in the on-disk response cache', async () => {
      repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
      const generate = jest.fn(async () => ({ response: findingsReply([]) }));
      setAIClient(new OllamaAIClient({ generate } as unknown as Ollama));
      const originalCwd = process.cwd();
      process.chdir(repo.root);

      try {
        await runCheck(repo, { base: 'main' });
        await runCheck(repo, { base: 'main' });
      } finally {
        process.chdir(originalCwd);
      }

      // Every run asks the model again and leaves nothing behind in the checkout.
      expect(generate).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(path.join(repo.root, '.dhruv-cache'))).toBe(false);
      expect(repo.git('status', '--porcelain', '--ignored')).toBe('');
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
      expect(parsed.findings).toEqual([]);
      expect(parsed.exclusions).toEqual([]);
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
