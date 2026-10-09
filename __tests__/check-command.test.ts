import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from '../src/commands/check';
import type { CheckOptions } from '../src/commands/check';
import { runCheckCli } from '../src/check/cli';
import { findBuiltInCommand } from '../src/commands/built-in-commands';
import type { Ollama } from 'ollama';
import { OllamaAIClient, setAIClient } from '../src/core/ai';
import type { AIClient, AIRequest } from '../src/core/ai';
import * as loggerModule from '../src/core/logger';
import { resetSessionConfig, setSessionConfig } from '../src/config/config';
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
  policy: Record<string, unknown>;
  summary: { findings: number; bySeverity: Record<string, number>; candidates: number; omitted: { invalid: number; offDiff: number; duplicate: number; belowMinSeverity: number } };
  coverage: { changedFiles: number; analyzedFiles: number; skippedFiles: number; truncatedFiles: number; complete: boolean; byReason: Record<string, number> };
  exclusions: Array<{ path: string; reason: string }>;
  error: { kind: string; message: string; hint?: string };
}

/** Every exclusion reason, as counted in `coverage.byReason`. */
const NO_EXCLUSIONS = {
  ignored: 0, deleted: 0, binary: 0, unsupported: 0, 'no-line-changes': 0,
  unreadable: 0, oversized: 0, 'file-limit': 0, 'total-limit': 0, truncated: 0,
};

const DEFAULT_POLICY = {
  file: null,
  schemaVersion: 1,
  include: ['**'],
  exclude: [],
  maxChangedFiles: 50,
  maxFileBytes: 65536,
  maxTotalBytes: 262144,
  minSeverity: 'info',
  overrides: [],
};

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
async function runCheck(repo: TempRepo, options: CheckOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  try {
    await check(options, { cwd: repo.root });
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

      const result = await runCheck(repo, { base: 'main', maxChangedFiles: 2 });

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

      const result = await runCheck(repo, { base: 'main', maxFileBytes: 500 });

      expect(client.requests[0].prompt).toContain('src/small.ts');
      expect(client.requests[0].prompt).not.toContain('src/big.ts');
      expect(result.stdout).toMatch(/oversized/);
      expect(result.stdout).toMatch(/incomplete/i);
    });

    it('stops adding files once the total prompt budget is spent', async () => {
      repo.commit({ 'src/a.ts': `${'export const a = 1;\n'.repeat(20)}`, 'src/b.ts': `${'export const b = 1;\n'.repeat(20)}` });

      const result = await runCheck(repo, { base: 'main', maxTotalBytes: 700 });

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
      expect(Object.keys(parsed).sort()).toEqual(['command', 'coverage', 'exclusions', 'findings', 'model', 'policy', 'refs', 'schemaVersion', 'status', 'summary']);
      expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'ok', model: 'test-model' });
      expect(parsed.refs).toEqual({ base: { ref: 'main', commit: baseSha }, mergeBase: baseSha, head });
      expect(parsed.coverage).toEqual({
        changedFiles: 2,
        analyzedFiles: 1,
        skippedFiles: 1,
        truncatedFiles: 0,
        complete: true,
        byReason: { ...NO_EXCLUSIONS, deleted: 1 },
      });
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

  describe('policy and coverage', () => {
    const POLICY_FILE = '.dhruv-check.json';
    const CHANGED_APP = 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\nexport const d = 4;\n';

    const useReply = (reply: string) => {
      client = new FakeClient(() => reply);
      setAIClient(client);
    };
    /** Checks in a policy on the base branch, so it is not itself part of the reviewed range. */
    const policyOnBase = (policy: unknown) => {
      repo.git('checkout', '-q', 'main');
      repo.commit({ [POLICY_FILE]: typeof policy === 'string' ? policy : JSON.stringify(policy) }, 'policy');
      repo.git('checkout', '-q', '-B', 'feature');
    };
    const jsonCheck = async (options: CheckOptions = {}) => {
      setSessionConfig({ responseFormat: 'json', model: 'test-model' });
      const result = await runCheck(repo, { base: 'main', ...options });
      resetSessionConfig();
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      return { ...result, parsed: JSON.parse(result.stdout) as JsonResult };
    };
    const lastPrompt = () => client.requests[client.requests.length - 1].prompt;

    describe('project policy', () => {
      it('uses explicit defaults when no policy is checked in', async () => {
        repo.commit({ 'src/new.ts': 'export const n = 1;\n' });
        // A policy that was never committed does not take part, even a broken one.
        repo.write(POLICY_FILE, '{ not json');

        const text = await runCheck(repo, { base: 'main' });
        const { parsed, exitCode } = await jsonCheck();

        expect(exitCode).toBe(0);
        expect(parsed.policy).toEqual(DEFAULT_POLICY);
        expect(text.stdout).toMatch(/^Policy built-in defaults$/m);
      });

      it('applies the include and exclude globs of the checked-in policy', async () => {
        const policy = { schemaVersion: 1, include: ['src/**', 'tools'], exclude: ['src/generated/', '*.gen.ts'] };
        policyOnBase(policy);
        repo.commit({
          'src/app.ts': CHANGED_APP,
          'src/generated/client.ts': 'export const GENERATED_MARKER = 1;\n',
          'src/deep/api.gen.ts': 'export const GEN_SUFFIX_MARKER = 1;\n',
          'tools/build.ts': 'export const TOOLS_MARKER = 1;\n',
          'scripts/release.ts': 'export const OUT_OF_SCOPE_MARKER = 1;\n',
        });

        const text = await runCheck(repo, { base: 'main' });
        const { parsed, exitCode } = await jsonCheck();

        expect(exitCode).toBe(0);
        expect(lastPrompt()).toContain('export const b = 22;');
        expect(lastPrompt()).toContain('TOOLS_MARKER');
        for (const marker of ['GENERATED_MARKER', 'GEN_SUFFIX_MARKER', 'OUT_OF_SCOPE_MARKER', 'src/generated', 'scripts/release.ts']) {
          expect(lastPrompt()).not.toContain(marker);
        }
        expect(parsed.exclusions).toEqual([
          { path: 'scripts/release.ts', reason: 'ignored' },
          { path: 'src/deep/api.gen.ts', reason: 'ignored' },
          { path: 'src/generated/client.ts', reason: 'ignored' },
        ]);
        // Paths the policy leaves out are not relevant source, so coverage stays complete.
        expect(parsed.coverage).toEqual({
          changedFiles: 5,
          analyzedFiles: 2,
          skippedFiles: 3,
          truncatedFiles: 0,
          complete: true,
          byReason: { ...NO_EXCLUSIONS, ignored: 3 },
        });
        expect(parsed.policy).toEqual({ ...DEFAULT_POLICY, file: POLICY_FILE, include: policy.include, exclude: policy.exclude });
        expect(text.stdout).toMatch(/^Policy \.dhruv-check\.json$/m);
        expect(text.stdout).toMatch(/src\/generated\/client\.ts\s+\(ignored\)/);
      });

      it('matches globs by path segment and anchors a pattern that contains a slash', async () => {
        repo.commit({
          'src/a.ts': 'export const a = 1;\n',
          'pkg/src/b.ts': 'export const b = 1;\n',
          'lib/one/index.ts': 'export const one = 1;\n',
          'lib/one/two/index.ts': 'export const two = 1;\n',
          'lib/x/deep/y/mod.ts': 'export const mod = 1;\n',
          'lib/mod.ts': 'export const top = 1;\n',
          'test1.ts': 'export const t1 = 1;\n',
          'pkg/test2.ts': 'export const t2 = 1;\n',
          'test10.ts': 'export const t10 = 1;\n',
        });

        const { parsed } = await jsonCheck({ include: ['/src', 'lib/*/index.ts', 'lib/**/mod.ts', 'test?.ts'] });

        expect(lastPrompt().match(/^FILE \S+/gm)).toEqual([
          'FILE lib/mod.ts', 'FILE lib/one/index.ts', 'FILE lib/x/deep/y/mod.ts', 'FILE pkg/test2.ts', 'FILE src/a.ts', 'FILE test1.ts',
        ]);
        expect(parsed.exclusions).toEqual([
          { path: 'lib/one/two/index.ts', reason: 'ignored' },
          { path: 'pkg/src/b.ts', reason: 'ignored' },
          { path: 'test10.ts', reason: 'ignored' },
        ]);
      });

      it('reads the policy committed at HEAD, never the working tree, and never sends it to the model', async () => {
        repo.commit({
          [POLICY_FILE]: JSON.stringify({ schemaVersion: 1, exclude: ['src/skip.ts'] }),
          'src/skip.ts': 'export const SKIPPED_MARKER = 1;\n',
          'src/keep.ts': 'export const k = 1;\n',
        });
        repo.write(POLICY_FILE, '{ not json');

        const { parsed, exitCode } = await jsonCheck();

        expect(exitCode).toBe(0);
        expect(parsed.policy).toMatchObject({ file: POLICY_FILE, exclude: ['src/skip.ts'] });
        expect(parsed.exclusions).toEqual([
          { path: POLICY_FILE, reason: 'unsupported' },
          { path: 'src/skip.ts', reason: 'ignored' },
        ]);
        expect(lastPrompt()).toContain('src/keep.ts');
        expect(lastPrompt()).not.toContain('SKIPPED_MARKER');
        expect(lastPrompt()).not.toContain('schemaVersion');
      });

      it.each<[string, unknown, RegExp]>([
        ['malformed JSON', '{ "schemaVersion": 1, ', /not valid JSON/],
        ['a document that is not an object', '["src/**"]', /must be a JSON object/],
        ['no schemaVersion', {}, /schemaVersion/],
        ['an unsupported schemaVersion', { schemaVersion: 2 }, /schemaVersion/],
        ['a misspelled setting', { schemaVersion: 1, exlude: ['dist/**'] }, /exlude/],
        ['a limit of the wrong type', { schemaVersion: 1, maxChangedFiles: '50' }, /maxChangedFiles/],
        ['a limit below one', { schemaVersion: 1, maxFileBytes: 0 }, /maxFileBytes/],
        ['a fractional limit', { schemaVersion: 1, maxTotalBytes: 1.5 }, /maxTotalBytes/],
        ['an undocumented severity', { schemaVersion: 1, minSeverity: 'blocker' }, /minSeverity/],
        ['globs that are not a list', { schemaVersion: 1, include: 'src/**' }, /include/],
        ['an empty include list', { schemaVersion: 1, include: [] }, /include/],
        ['a negated glob', { schemaVersion: 1, exclude: ['!src/keep.ts'] }, /exclude/],
        ['a glob that leaves the repository', { schemaVersion: 1, include: ['../other/**'] }, /include/],
        ['more than 64 KiB', `{"schemaVersion":1}${' '.repeat(70 * 1024)}`, /larger than/],
      ])('fails before any AI request when the policy has %s', async (_label, policy, expected) => {
        policyOnBase(policy);
        repo.commit({ 'src/new.ts': 'export const n = 1;\n' });

        const text = await runCheck(repo, { base: 'main' });
        const { parsed, exitCode } = await jsonCheck();

        expect(text.exitCode).toBe(1);
        expect(text.stdout).toBe('');
        expect(text.stderr).toContain(POLICY_FILE);
        expect(text.stderr).toMatch(expected);
        expect(exitCode).toBe(1);
        expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'error' });
        expect(parsed.error.kind).toBe('invalid-policy');
        expect(parsed.error.message).toMatch(expected);
        expect(parsed).not.toHaveProperty('findings');
        expect(client.requests).toHaveLength(0);
      });

      it('names every problem of an invalid policy at once', async () => {
        policyOnBase({ schemaVersion: 1, exlude: ['dist/**'], maxChangedFiles: 0, minSeverity: 'blocker' });
        repo.commit({ 'src/new.ts': 'export const n = 1;\n' });

        const result = await runCheck(repo, { base: 'main' });

        expect(result.exitCode).toBe(1);
        for (const setting of ['exlude', 'maxChangedFiles', 'minSeverity']) expect(result.stderr).toContain(setting);
        expect(client.requests).toHaveLength(0);
      });

      it('rejects a policy that is a symbolic link without following it', async () => {
        repo.commit({ 'src/new.ts': 'export const n = 1;\n', 'LINK_TARGET_MARKER.json': '{"schemaVersion":1}' });
        // Commits the link as Git stores it, which works on every platform.
        repo.write('link-target', 'LINK_TARGET_MARKER.json');
        const blob = repo.git('hash-object', '-w', 'link-target');
        fs.rmSync(path.join(repo.root, 'link-target'));
        repo.git('update-index', '--add', '--cacheinfo', `120000,${blob},${POLICY_FILE}`);
        repo.git('commit', '-q', '-m', 'policy link');

        const result = await runCheck(repo, { base: 'main' });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(POLICY_FILE);
        expect(result.stderr).toMatch(/regular file/);
        expect(result.stderr).not.toContain('LINK_TARGET_MARKER');
        expect(client.requests).toHaveLength(0);
      });
    });

    describe('command-line overrides', () => {
      it('override the checked-in policy for one run without rewriting it', async () => {
        const policy = JSON.stringify({ schemaVersion: 1, exclude: ['src/b.ts'], maxChangedFiles: 1, minSeverity: 'high' });
        policyOnBase(policy);
        const head = repo.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' });

        const checkedIn = await jsonCheck();
        const overridden = await jsonCheck({ maxChangedFiles: '5', exclude: ['src/a.ts'], minSeverity: 'low' });
        const text = await runCheck(repo, { base: 'main', maxChangedFiles: '5' });

        expect(checkedIn.parsed.policy).toEqual({ ...DEFAULT_POLICY, file: POLICY_FILE, exclude: ['src/b.ts'], maxChangedFiles: 1, minSeverity: 'high' });
        expect(checkedIn.parsed.exclusions).toEqual([{ path: 'src/b.ts', reason: 'ignored' }, { path: 'src/c.ts', reason: 'file-limit' }]);
        expect(overridden.parsed.policy).toEqual({
          ...DEFAULT_POLICY,
          file: POLICY_FILE,
          exclude: ['src/a.ts'],
          maxChangedFiles: 5,
          minSeverity: 'low',
          overrides: ['exclude', 'maxChangedFiles', 'minSeverity'],
        });
        expect(overridden.parsed.exclusions).toEqual([{ path: 'src/a.ts', reason: 'ignored' }]);
        expect(text.stdout).toMatch(/^Policy \.dhruv-check\.json, overridden for this run: maxChangedFiles$/m);
        // The checked-in file and the checkout are exactly as they were.
        expect(repo.git('show', `HEAD:${POLICY_FILE}`)).toBe(policy);
        expect(fs.readFileSync(path.join(repo.root, POLICY_FILE), 'utf8')).toBe(policy);
        expect(repo.git('status', '--porcelain')).toBe('');
        expect(repo.git('rev-parse', 'HEAD')).toBe(head);
      });

      it('accept every policy setting when no policy is checked in', async () => {
        repo.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/x.ts': 'export const x = 1;\n', 'tools/t.ts': 'export const t = 1;\n' });

        const { parsed, exitCode } = await jsonCheck({
          include: ['src/**'], exclude: ['src/x.ts'], maxChangedFiles: '7', maxFileBytes: '1000', maxTotalBytes: '2000', minSeverity: 'medium',
        });

        expect(exitCode).toBe(0);
        expect(parsed.policy).toEqual({
          file: null,
          schemaVersion: 1,
          include: ['src/**'],
          exclude: ['src/x.ts'],
          maxChangedFiles: 7,
          maxFileBytes: 1000,
          maxTotalBytes: 2000,
          minSeverity: 'medium',
          overrides: ['include', 'exclude', 'maxChangedFiles', 'maxFileBytes', 'maxTotalBytes', 'minSeverity'],
        });
        expect(parsed.exclusions).toEqual([{ path: 'src/x.ts', reason: 'ignored' }, { path: 'tools/t.ts', reason: 'ignored' }]);
      });

      it.each<[string, CheckOptions, RegExp]>([
        ['a limit that is not a number', { maxChangedFiles: 'many' }, /--max-changed-files/],
        ['a zero limit', { maxFileBytes: '0' }, /--max-file-bytes/],
        ['a negative limit', { maxTotalBytes: '-5' }, /--max-total-bytes/],
        ['a fractional limit', { maxChangedFiles: '1.5' }, /--max-changed-files/],
        ['an undocumented severity', { minSeverity: 'blocker' }, /--min-severity/],
        ['a negated glob', { exclude: ['!src/a.ts'] }, /--exclude/],
        ['an empty glob', { include: [''] }, /--include/],
      ])('reject %s before any AI request', async (_label, options, expected) => {
        repo.commit({ 'src/new.ts': 'export const n = 1;\n' });

        const text = await runCheck(repo, { base: 'main', ...options });
        const { parsed, exitCode } = await jsonCheck(options);

        expect(text.exitCode).toBe(1);
        expect(text.stdout).toBe('');
        expect(text.stderr).toMatch(expected);
        expect(exitCode).toBe(1);
        expect(parsed.status).toBe('error');
        expect(parsed.error.kind).toBe('invalid-input');
        expect(client.requests).toHaveLength(0);
      });

      it('are read from the command line', async () => {
        repo.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n', 'src/d.ts': 'export const d = 1;\n', 'tools/t.ts': 'export const t = 1;\n' });
        const stdout: string[] = [];
        const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
        const originalCwd = process.cwd();
        process.chdir(repo.root);

        try {
          await runCheckCli([
            'node', 'dhruv', '--json', 'check', '--base', 'main', '--include', 'src/**', '--exclude', 'src/a.ts', 'src/b.ts',
            '--max-changed-files', '1', '--max-file-bytes', '4096', '--max-total-bytes', '8192', '--min-severity', 'high', '--strict-coverage',
          ]);
        } finally {
          process.chdir(originalCwd);
          outSpy.mockRestore();
        }

        const parsed = JSON.parse(stdout.join('')) as JsonResult;
        expect(parsed.policy).toEqual({
          file: null,
          schemaVersion: 1,
          include: ['src/**'],
          exclude: ['src/a.ts', 'src/b.ts'],
          maxChangedFiles: 1,
          maxFileBytes: 4096,
          maxTotalBytes: 8192,
          minSeverity: 'high',
          overrides: ['include', 'exclude', 'maxChangedFiles', 'maxFileBytes', 'maxTotalBytes', 'minSeverity'],
        });
        expect(parsed.exclusions).toEqual([
          { path: 'src/a.ts', reason: 'ignored' },
          { path: 'src/b.ts', reason: 'ignored' },
          { path: 'src/d.ts', reason: 'file-limit' },
          { path: 'tools/t.ts', reason: 'ignored' },
        ]);
        expect(parsed.status).toBe('incomplete');
        expect(process.exitCode).toBe(2);
      });
    });

    describe('minimum severity', () => {
      it('hides findings below the minimum and counts them', async () => {
        policyOnBase({ schemaVersion: 1, minSeverity: 'medium' });
        repo.commit({ 'src/app.ts': CHANGED_APP });
        useReply(findingsReply([
          candidate({ severity: 'critical', reason: 'Shown critical' }),
          candidate({ line: 4, severity: 'medium', reason: 'Shown medium' }),
          candidate({ severity: 'low', reason: 'Hidden low' }),
          candidate({ line: 4, severity: 'info', reason: 'Hidden info' }),
        ]));

        const text = await runCheck(repo, { base: 'main' });
        const { parsed } = await jsonCheck();
        const everything = await jsonCheck({ minSeverity: 'info' });

        expect(parsed.findings.map(({ reason }) => reason)).toEqual(['Shown critical', 'Shown medium']);
        expect(parsed.summary).toEqual({
          findings: 2,
          bySeverity: { critical: 1, high: 0, medium: 1, low: 0, info: 0 },
          candidates: 4,
          omitted: { invalid: 0, offDiff: 0, duplicate: 0, belowMinSeverity: 2 },
        });
        expect(text.stdout).toMatch(/2 findings: 1 critical, 1 medium\./);
        expect(text.stdout).toMatch(/Hidden 2 findings below medium severity\./);
        expect(text.stdout).not.toContain('Hidden low');
        expect(text.stdout).not.toContain('Hidden info');
        expect(everything.parsed.findings).toHaveLength(4);
        expect(everything.parsed.summary.omitted.belowMinSeverity).toBe(0);
      });
    });

    describe('coverage', () => {
      it('reports every exclusion with its reason and counts them', async () => {
        policyOnBase({ schemaVersion: 1, exclude: ['vendor'] });
        repo.git('rm', '-q', 'src/app.ts');
        repo.commit({
          'README.md': '# changed\n',
          'src/huge.ts': 'export const h = 1;\n'.repeat(200),
          'src/image.ts': Buffer.from([0x00, 0x01, 0x02, 0x00]),
          'src/ok.ts': 'export const ok = 1;\n',
          'vendor/lib.ts': 'export const VENDOR_MARKER = 1;\n',
        });

        const text = await runCheck(repo, { base: 'main', maxFileBytes: 500 });
        const { parsed } = await jsonCheck({ maxFileBytes: 500 });

        expect(parsed.exclusions).toEqual([
          { path: 'README.md', reason: 'unsupported' },
          { path: 'src/app.ts', reason: 'deleted' },
          { path: 'src/huge.ts', reason: 'oversized' },
          { path: 'src/image.ts', reason: 'binary' },
          { path: 'vendor/lib.ts', reason: 'ignored' },
        ]);
        expect(parsed.coverage).toEqual({
          changedFiles: 6,
          analyzedFiles: 1,
          skippedFiles: 5,
          truncatedFiles: 0,
          complete: false,
          byReason: { ...NO_EXCLUSIONS, ignored: 1, deleted: 1, binary: 1, unsupported: 1, oversized: 1 },
        });
        expect(text.stdout).toMatch(/Analyzed 1 of 6 changed files \(coverage incomplete\)\./);
        expect(text.stdout).toMatch(/Not analyzed \(5\): 1 ignored, 1 deleted, 1 binary, 1 unsupported, 1 oversized/);
        for (const { path: file, reason } of parsed.exclusions) expect(text.stdout).toContain(`  ${file}  (${reason})`);
        expect(lastPrompt()).not.toContain('VENDOR_MARKER');
      });

      it('truncates a file at a hunk boundary and reports the rest as unreviewed', async () => {
        const lines = Array.from({ length: 80 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
        const base = repo.commit({ 'src/long.ts': `${lines.join('\n')}\n` }, 'long file');
        lines[2] = 'export const line3 = "FIRST_HUNK";';
        lines[69] = 'export const line70 = "SECOND_HUNK";';
        repo.commit({ 'src/long.ts': `${lines.join('\n')}\n` });
        useReply(findingsReply([
          candidate({ path: 'src/long.ts', line: 3, reason: 'In the reviewed part' }),
          candidate({ path: 'src/long.ts', line: 70, reason: 'In the cut part' }),
        ]));

        const text = await runCheck(repo, { base, maxFileBytes: 600 });
        const { parsed, exitCode } = await jsonCheck({ base, maxFileBytes: 600 });

        expect(lastPrompt()).toContain('FIRST_HUNK');
        expect(lastPrompt()).not.toContain('SECOND_HUNK');
        expect(lastPrompt()).toMatch(/src\/long\.ts[^\n]*changed lines: 3\n/);
        expect(exitCode).toBe(0);
        expect(parsed.status).toBe('ok');
        expect(parsed.exclusions).toEqual([{ path: 'src/long.ts', reason: 'truncated' }]);
        expect(parsed.coverage).toEqual({
          changedFiles: 1,
          analyzedFiles: 1,
          skippedFiles: 0,
          truncatedFiles: 1,
          complete: false,
          byReason: { ...NO_EXCLUSIONS, truncated: 1 },
        });
        // A finding in the part that was cut is not grounded in what the model saw.
        expect(parsed.findings.map(({ reason }) => reason)).toEqual(['In the reviewed part']);
        expect(parsed.summary.omitted.offDiff).toBe(1);
        expect(text.stdout).toMatch(/Analyzed 1 of 1 changed file \(coverage incomplete\)\./);
        expect(text.stdout).toMatch(/Partially analyzed \(1\):\n {2}src\/long\.ts {2}\(truncated\)/);
      });

      it('reports a change Git cannot read as unreadable', async () => {
        repo.commit({ 'src/app.ts': CHANGED_APP, 'src/ok.ts': 'export const ok = 1;\n' });
        const blob = repo.git('rev-parse', 'HEAD:src/app.ts');
        const object = path.join(repo.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
        fs.chmodSync(object, 0o644);
        fs.rmSync(object);

        const { parsed, exitCode } = await jsonCheck();

        expect(exitCode).toBe(0);
        expect(parsed.exclusions).toEqual([{ path: 'src/app.ts', reason: 'unreadable' }]);
        expect(parsed.coverage).toMatchObject({ analyzedFiles: 1, skippedFiles: 1, complete: false, byReason: { unreadable: 1 } });
        expect(lastPrompt()).toContain('src/ok.ts');
      });

      it('applies limits to the selected files in path order, the same way every run', async () => {
        repo.commit({
          'src/e.ts': 'export const e = 1;\n',
          'src/c.ts': `${'export const c = 1;\n'.repeat(20)}`,
          'src/a.ts': 'export const a = 1;\n',
          'src/d.ts': 'export const d = 1;\n',
          'src/b.ts': `${'export const b = 1;\n'.repeat(20)}`,
          'src/f.ts': 'export const f = 1;\n',
        });
        const options = { exclude: ['src/a.ts'], maxChangedFiles: 4, maxTotalBytes: 700 };

        const first = await jsonCheck(options);
        const second = await jsonCheck(options);

        // b fills most of the budget, c no longer fits, the smaller d and e still do, f is past the file limit.
        expect(first.parsed.exclusions).toEqual([
          { path: 'src/a.ts', reason: 'ignored' },
          { path: 'src/c.ts', reason: 'total-limit' },
          { path: 'src/f.ts', reason: 'file-limit' },
        ]);
        expect(first.parsed.coverage).toEqual({
          changedFiles: 6,
          analyzedFiles: 3,
          skippedFiles: 3,
          truncatedFiles: 0,
          complete: false,
          byReason: { ...NO_EXCLUSIONS, ignored: 1, 'total-limit': 1, 'file-limit': 1 },
        });
        expect(client.requests[0].prompt.match(/^FILE \S+/gm)).toEqual(['FILE src/b.ts', 'FILE src/d.ts', 'FILE src/e.ts']);
        expect(second.stdout).toBe(first.stdout);
        expect(client.requests[1].prompt).toBe(client.requests[0].prompt);
      });

      it('sends only the selected diff with bounded context', async () => {
        const lines = Array.from({ length: 60 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
        lines[39] = 'export const line40 = "FAR_CONTEXT_MARKER";';
        const base = repo.commit({
          'src/long.ts': `${lines.join('\n')}\n`,
          'src/untouched.ts': 'export const UNTOUCHED_MARKER = 1;\n',
          'config/secrets.ts': 'export const SECRET_MARKER = 1;\n',
        }, 'more base');
        lines[4] = 'export const line5 = "CHANGED_MARKER";';
        repo.commit({ 'src/long.ts': `${lines.join('\n')}\n`, 'config/secrets.ts': 'export const SECRET_MARKER = 2;\n' });

        const { exitCode } = await jsonCheck({ base, exclude: ['config/**'] });

        expect(exitCode).toBe(0);
        expect(client.requests).toHaveLength(1);
        expect(lastPrompt()).toContain('CHANGED_MARKER');
        expect(lastPrompt()).toContain('export const line15 = 15;');
        for (const marker of ['export const line16 = 16;', 'FAR_CONTEXT_MARKER', 'UNTOUCHED_MARKER', 'SECRET_MARKER', 'config/secrets.ts']) {
          expect(lastPrompt()).not.toContain(marker);
        }
      });
    });

    describe('strict versus advisory coverage', () => {
      beforeEach(() => {
        repo.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
      });

      it('keeps incomplete coverage advisory by default, and never reads zero findings as full coverage', async () => {
        const text = await runCheck(repo, { base: 'main', maxChangedFiles: 1 });
        const { parsed, exitCode } = await jsonCheck({ maxChangedFiles: 1 });

        expect(text.exitCode).toBe(0);
        expect(text.stderr).toBe('');
        expect(text.stdout).toMatch(/Analyzed 1 of 2 changed files \(coverage incomplete\)\./);
        expect(text.stdout).toMatch(/No findings in the analyzed changes\. Coverage is incomplete/);
        expect(text.stdout).not.toMatch(/^No findings\.$/m);
        expect(exitCode).toBe(0);
        expect(parsed.status).toBe('ok');
        expect(parsed.findings).toEqual([]);
        expect(parsed.coverage).toMatchObject({ complete: false, analyzedFiles: 1, skippedFiles: 1 });
        expect(parsed.exclusions).toEqual([{ path: 'src/b.ts', reason: 'file-limit' }]);
      });

      it('exits 2 with an incomplete status under --strict-coverage and still reports what it reviewed', async () => {
        useReply(findingsReply([candidate({ path: 'src/a.ts', line: 1 })]));

        const text = await runCheck(repo, { base: 'main', maxChangedFiles: 1, strictCoverage: true });
        const { parsed, exitCode, stderr } = await jsonCheck({ maxChangedFiles: 1, strictCoverage: true });

        expect(text.exitCode).toBe(2);
        expect(text.stdout).toContain('src/a.ts:1');
        expect(text.stdout).toMatch(/coverage incomplete/);
        expect(text.stderr).toMatch(/--strict-coverage/);
        expect(exitCode).toBe(2);
        expect(stderr).toBe('');
        expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'incomplete' });
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.coverage.complete).toBe(false);
        expect(parsed).not.toHaveProperty('error');
        expect(client.requests).toHaveLength(2);
      });

      it('exits 2 without an AI request when nothing relevant could be analyzed', async () => {
        const { parsed, exitCode } = await jsonCheck({ maxFileBytes: 5, strictCoverage: true });

        expect(exitCode).toBe(2);
        expect(parsed.status).toBe('incomplete');
        expect(parsed.findings).toEqual([]);
        expect(parsed.coverage).toMatchObject({ analyzedFiles: 0, complete: false, byReason: { oversized: 2 } });
        expect(client.requests).toHaveLength(0);
      });

      it('exits 0 under --strict-coverage when only irrelevant changes were skipped', async () => {
        repo.git('rm', '-q', 'README.md');
        repo.git('mv', 'src/app.ts', 'src/moved.ts');
        repo.commit({ 'docs/guide.md': '# guide\n', 'src/image.ts': Buffer.from([0x00, 0x01, 0x02, 0x00]) });

        const { parsed, exitCode } = await jsonCheck({ exclude: ['src/b.ts'], strictCoverage: true });

        expect(exitCode).toBe(0);
        expect(parsed.status).toBe('ok');
        expect(parsed.coverage).toEqual({
          changedFiles: 6,
          analyzedFiles: 1,
          skippedFiles: 5,
          truncatedFiles: 0,
          complete: true,
          byReason: { ...NO_EXCLUSIONS, ignored: 1, deleted: 1, binary: 1, unsupported: 1, 'no-line-changes': 1 },
        });
      });

      it('reports a failed AI request as an error even under --strict-coverage', async () => {
        setAIClient(new FakeClient(() => { throw { kind: 'connection', cause: 'ECONNREFUSED' }; }));

        const { parsed, exitCode } = await jsonCheck({ maxChangedFiles: 1, strictCoverage: true });

        expect(exitCode).toBe(1);
        expect(parsed.status).toBe('error');
        expect(parsed.error.kind).toBe('ai-connection');
      });
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

  it('exits 2 with one incomplete JSON object when --strict-coverage meets skipped source', () => {
    const repo = new TempRepo('dhruv-check-strict-');
    try {
      repo.commit({ 'src/app.ts': 'export const a = 1;\n' }, 'base');
      repo.git('checkout', '-q', '-b', 'feature');
      repo.commit({ 'src/app.ts': 'export const a = 2;\n' });
      // Nothing fits one byte, so the outcome is decided without a model.
      const run = spawnSync(process.execPath, ['--loader', loader, entry, '--json', 'check', '--base', 'main', '--max-file-bytes', '1', '--strict-coverage'], {
        cwd: repo.root,
        encoding: 'utf8',
        env: { ...process.env, TS_NODE_PROJECT: path.resolve(project, 'tsconfig.json'), DHRUV_METRICS_ENABLED: 'false' },
      });

      expect(run.status).toBe(2);
      const parsed = JSON.parse(run.stdout) as JsonResult;
      expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'incomplete', findings: [] });
      expect(parsed.coverage).toMatchObject({ analyzedFiles: 0, complete: false });
      expect(parsed.exclusions).toEqual([{ path: 'src/app.ts', reason: 'oversized' }]);
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
    expect(out).toContain('.dhruv-check.json');
    for (const flag of ['--include <globs...>', '--exclude <globs...>', '--max-changed-files <count>', '--max-file-bytes <bytes>', '--max-total-bytes <bytes>', '--min-severity <severity>', '--strict-coverage']) {
      expect(out).toContain(flag);
    }
  }, 30000);
});
