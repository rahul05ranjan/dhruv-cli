/**
 * Contract between the `dhruv check` guide (docs/check.md), the README and the
 * command: every documented invocation, example and reference table is checked
 * against the definitions and against real runs, so the documentation cannot
 * drift silently. When one of these tests fails, fix whichever side is wrong.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { runCheckCli } from '../src/check/cli';
import { check } from '../src/commands/check';
import { checkCommand } from '../src/commands/definitions/check-command';
import { globalOptions } from '../src/commands/global-options';
import { resetSessionConfig, setSessionConfig } from '../src/config/config';
import { setAIClient } from '../src/core/ai';
import type { AIClient, AIRequest } from '../src/core/ai';
import { CHECK_SEVERITIES } from '../src/core/check-findings';
import { CHECK_POLICY_FILE, DEFAULT_CHECK_POLICY, resolveCheckPolicy } from '../src/core/check-policy';
import { CHECK_EXIT } from '../src/core/check-presentation';
import { COVERAGE_BREAKING, EXCLUSION_REASONS } from '../src/core/committed-range';
import { CODE_FILE } from '../src/core/source-ingestion';
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

const project = path.resolve(__dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(project, file), 'utf8').replace(/\r\n/g, '\n');
const guide = read('docs/check.md');
const readme = read('README.md');

type Row = Record<string, string>;

/** The text of a guide section, from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const lines = guide.split('\n');
  const start = lines.findIndex((line) => /^#{2,3} /.test(line) && line.replace(/^#+ /, '') === heading);
  if (start === -1) throw new Error(`docs/check.md has no section "${heading}"`);
  const level = lines[start].indexOf(' ');
  const body: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) fenced = !fenced;
    const next = fenced ? null : /^(#+) /.exec(line);
    if (next && next[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The fenced blocks of one language in a text, in order. */
function fencedBlocks(text: string, language: string): string[] {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].filter((match) => match[1] === language).map((match) => match[2]);
}

function fencedBlock(heading: string, language: string): string {
  const [block] = fencedBlocks(section(heading), language);
  if (block === undefined) throw new Error(`Section "${heading}" has no ${language} block`);
  return block;
}

/** The first backtick-quoted value of a table cell, or the cell itself. */
function code(cell: string): string {
  return /`([^`]*)`/.exec(cell)?.[1] ?? cell;
}

/** The tables of a guide section; each row is keyed by its column heading. */
function tables(heading: string): Row[][] {
  const found: Row[][] = [];
  let current: string[][] = [];
  for (const line of [...section(heading).split('\n'), '']) {
    if (line.startsWith('|')) {
      current.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
    } else if (current.length > 0) {
      const [header, , ...rows] = current;
      found.push(rows.map((row) => Object.fromEntries(header.map((name, index) => [code(name), row[index]]))));
      current = [];
    }
  }
  return found;
}

interface DocumentedCommand {
  words: string[];
  /** Where the documentation sends stdout, when it redirects it. */
  redirect?: string;
}

/** Reads the `dhruv … check` command lines of a shell script the way a shell would split them. */
function checkCommands(script: string, env: Record<string, string> = {}): DocumentedCommand[] {
  return script.replace(/\\\n/g, ' ').split('\n')
    .map((line) => line.trim().replace(/\s+#.*$/, ''))
    .filter((line) => /^dhruv\s/.test(line) && /\scheck(\s|$)/.test(line))
    .map((line) => {
      const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
        .map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\$(\w+)/g, (_, name: string) => env[name] ?? `$${name}`));
      const redirect = words.indexOf('>');
      return redirect === -1 ? { words } : { words: words.slice(0, redirect), redirect: words[redirect + 1] };
    });
}

function flagName(flags: string): string {
  return flags.split(' ')[0];
}

function settingOf(flags: string): string {
  return flagName(flags).slice(2).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

class FakeClient implements AIClient {
  requests: AIRequest[] = [];

  constructor(private readonly reply: () => string | Promise<string> = () => JSON.stringify({ findings: [] })) {}

  async ask(request: AIRequest): Promise<string> {
    this.requests.push(request);
    return this.reply();
  }

  async listModels(): Promise<string[]> {
    return ['test-model'];
  }
}

/** What the model answers in the guide's example: one finding on a changed line and one off the diff. */
const EXAMPLE_REPLY = JSON.stringify({
  findings: [
    {
      path: 'src/payments/refund.ts',
      line: 2,
      severity: 'high',
      reason: 'Audit entry is written before the refund succeeds',
      evidence: 'audit(reason) runs before gateway.refund(amount), so a failed refund still leaves an audit record',
      recommendation: 'Write the audit entry after the gateway call succeeds, or record the failure as well',
    },
    { path: 'src/payments/refund.ts', line: 3, severity: 'low', reason: 'Amount is not validated', evidence: 'amount goes straight to the gateway', recommendation: 'Reject non-positive amounts' },
  ],
  note: 'RESPONSE_MARKER',
});

/** The repository behind the guide's examples: a feature branch one commit ahead of `origin/main`. */
function exampleRepo(extraBaseFiles: Record<string, string> = {}): TempRepo {
  const repo = new TempRepo('dhruv-check-docs-');
  repo.commit({
    [CHECK_POLICY_FILE]: JSON.stringify({ schemaVersion: 1, exclude: ['dist', '*.min.js'], minSeverity: 'low' }),
    'README.md': '# Payments\n',
    'src/payments/refund.ts': 'export function refund(amount: number) {\n  return gateway.refund(amount);\n}\n',
    ...extraBaseFiles,
  }, 'base');
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit({
    'README.md': '# Payments\n\nRefunds are audited.\n',
    'dist/bundle.js': 'var refund = 1;\n',
    'src/payments/refund.ts': 'export function refund(amount: number, reason: string) {\n  audit(reason); // SOURCE_MARKER\n  return gateway.refund(amount);\n}\n',
  }, 'audit refunds');
  return repo;
}

const RUN_DEFAULTS = { responseFormat: 'text', timeoutMs: 45000 } as const;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs a documented command line through the `check` entry point, in the repository, as a shell would. */
async function runDocumented(repo: TempRepo, words: string[]): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  const originalCwd = process.cwd();
  process.chdir(repo.root);
  // Other suites rewrite the project's .dhruv-config.json while this one runs; start every run from the defaults.
  setSessionConfig(RUN_DEFAULTS);
  try {
    await runCheckCli(['node', ...words]);
  } finally {
    process.chdir(originalCwd);
    outSpy.mockRestore();
    errSpy.mockRestore();
    resetSessionConfig();
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: Number(process.exitCode ?? 0) };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function json(run: Run): Json {
  expect(run.stdout.endsWith('\n')).toBe(true);
  expect(run.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(run.stdout) as Json;
}

/** Commit IDs differ on every run; everything else in an example must match exactly. */
function withoutCommitIds(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/g, '<commit>').replace(/\b[0-9a-f]{12}\b/g, '<short>');
}

describe('dhruv check documentation contract', () => {
  let repo: TempRepo;
  let client: FakeClient;

  beforeEach(() => {
    repo = exampleRepo();
    client = new FakeClient(() => EXAMPLE_REPLY);
    setAIClient(client);
  });

  afterEach(() => {
    resetSessionConfig();
    repo.remove();
  });

  const localCommands = () => checkCommands(fencedBlocks(section('Run it locally'), 'bash').join('\n'));
  const workflow = () => parse(fencedBlock('Run it in GitHub Actions', 'yaml')) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, {
      'runs-on': string[];
      env: Record<string, string>;
      steps: Array<{ name: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; 'working-directory'?: string }>;
    }>;
  };
  const workflowEnv = { BASE_REF: 'main', DHRUV_CHECK_MODEL: 'ci-model', RUNNER_TEMP: '/runner/temp' };

  describe('documented invocations', () => {
    const knownFlags = () => [...(checkCommand.options ?? []), ...globalOptions].map(({ flags }) => flagName(flags));

    it('uses only options that check accepts, wherever a command line is shown', () => {
      const scripts = [...fencedBlocks(guide, 'bash'), ...fencedBlocks(readme, 'bash'), ...workflow().jobs.check.steps.map((step) => step.run ?? '')];
      const commands = scripts.flatMap((script) => checkCommands(script));

      expect(commands.length).toBeGreaterThanOrEqual(6);
      for (const { words } of commands) {
        expect(words).toContain('--base');
        for (const flag of words.filter((word) => word.startsWith('--'))) expect(knownFlags()).toContain(flag);
      }
    });

    it('lists every option, with the policy key and default it replaces', () => {
      const [options] = tables('Options');
      const documented = new Map(options.map((row) => [code(row.Option), row]));

      for (const { flags } of checkCommand.options ?? []) expect([...documented.keys()]).toContain(flags);
      for (const flags of documented.keys()) expect([...(checkCommand.options ?? []), ...globalOptions].map((option) => option.flags)).toContain(flags);

      const defaults = DEFAULT_CHECK_POLICY as unknown as Record<string, unknown>;
      for (const [flags, row] of documented) {
        if (!row['Policy key']) continue;
        expect(code(row['Policy key'])).toBe(settingOf(flags));
        expect(Object.keys(defaults)).toContain(settingOf(flags));
        const value = defaults[settingOf(flags)];
        if (typeof value !== 'object') expect(code(row.Default)).toBe(String(value));
      }
    });

    it('states in help what the guide states about exit codes, and points at the guide', () => {
      const notes = (checkCommand.notes ?? []).join('\n');

      for (const row of tables('Exit codes')[0]) expect(notes).toMatch(new RegExp(`\\b${code(row['Exit code'])}\\b`));
      expect(notes).toContain('docs/check.md');
      expect(readme).toContain('(docs/check.md)');
    });

    it('prints the text result the guide shows for the local command', async () => {
      const [text] = localCommands();

      const result = await runDocumented(repo, text.words);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(withoutCommitIds(result.stdout)).toBe(withoutCommitIds(fencedBlock('Run it locally', 'text')));
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0].model).toBe(text.words[text.words.indexOf('--model') + 1]);
    });

    it('writes the JSON result the guide shows for the --json command', async () => {
      const [, asJson] = localCommands();
      expect(asJson.words).toEqual(expect.arrayContaining(['--json', '--strict-coverage']));
      expect(asJson.redirect).toBeDefined();

      const result = await runDocumented(repo, asJson.words);

      const example = fencedBlock('JSON result', 'json');
      const parsed = json(result);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(withoutCommitIds(result.stdout))).toEqual(JSON.parse(withoutCommitIds(example)));
      // The guide promises the key order too.
      expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(example) as Json));
    });
  });

  describe('policy reference', () => {
    it('shows an example policy that the command accepts and applies', async () => {
      const example = fencedBlock('Policy file', 'json');
      expect(resolveCheckPolicy(example)).toMatchObject({ ok: true });

      repo.commit({
        [CHECK_POLICY_FILE]: example,
        'src/app.ts': 'export const app = 1;\n',
        'src/generated/api.ts': 'export const api = 1;\n',
        'tools/build.ts': 'export const build = 1;\n',
        'vendor/lib.ts': 'export const lib = 1;\n',
      });
      const result = await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json']);

      const parsed = json(result);
      expect(parsed.policy).toEqual({ file: CHECK_POLICY_FILE, ...(JSON.parse(example) as Json), overrides: [] });
      const reasons = Object.fromEntries((parsed.exclusions as Array<{ path: string; reason: string }>).map(({ path: file, reason }) => [file, reason]));
      expect(reasons).toMatchObject({ 'src/generated/api.ts': 'ignored', 'tools/build.ts': 'ignored', 'vendor/lib.ts': 'ignored' });
      expect(reasons).not.toHaveProperty(['src/app.ts']);
    });

    it('documents every policy key with its real default', () => {
      const [keys] = tables('Policy file');
      const defaults = DEFAULT_CHECK_POLICY as unknown as Record<string, unknown>;

      expect(keys.map((row) => code(row.Key))).toEqual(['schemaVersion', ...Object.keys(defaults)]);
      for (const row of keys.slice(1)) expect(JSON.parse(code(row.Default))).toEqual(defaults[code(row.Key)]);
    });

    it('reads the policy from the HEAD commit, so a change can loosen its own review', async () => {
      const policy = JSON.stringify({ schemaVersion: 1, exclude: ['src', 'dist'] });
      repo.commit({ [CHECK_POLICY_FILE]: policy }, 'exclude my own change');
      // An uncommitted edit must not take part.
      repo.write(CHECK_POLICY_FILE, JSON.stringify({ schemaVersion: 1 }));

      const loosened = await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json', '--strict-coverage']);

      // As the guide warns: complete coverage and exit 0, with the evidence in the result.
      const parsed = json(loosened);
      expect(loosened.exitCode).toBe(0);
      expect(client.requests).toHaveLength(0);
      expect(parsed.policy).toMatchObject({ file: CHECK_POLICY_FILE, exclude: ['src', 'dist'] });
      expect(parsed.coverage).toMatchObject({ analyzedFiles: 0, complete: true });
      expect(parsed.exclusions).toEqual(expect.arrayContaining([
        { path: CHECK_POLICY_FILE, reason: 'unsupported' },
        { path: 'src/payments/refund.ts', reason: 'ignored' },
      ]));

      // And the documented remedy: a flag replaces the setting whatever the file says.
      const pinned = await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json', '--exclude', 'dist']);
      expect(json(pinned).policy).toMatchObject({ exclude: ['dist'], overrides: ['exclude'] });
      expect(client.requests).toHaveLength(1);
    });

    it('lists the file types that are reviewed', () => {
      const bullet = section('What is reviewed').split('\n').find((line) => line.includes('**Source files only.**')) ?? '';
      const documented = [...bullet.split('Every other')[0].matchAll(/`([^`]+)`/g)].map((match) => match[1]);

      expect(documented.length).toBeGreaterThan(0);
      expect(CODE_FILE.source).toBe(`\\.(${documented.join('|')})$`);
    });
  });

  describe('result reference', () => {
    it('documents each exclusion reason and whether it breaks coverage', () => {
      const [reasons] = tables('Coverage and exclusion reasons');

      expect(reasons.map((row) => code(row.Reason))).toEqual([...EXCLUSION_REASONS]);
      for (const row of reasons) {
        expect(row['Coverage stays complete']).toBe(COVERAGE_BREAKING.includes(code(row.Reason) as typeof COVERAGE_BREAKING[number]) ? 'no' : 'yes');
      }
    });

    it('documents a change that only removes lines as unreviewed', async () => {
      repo.commit({ 'src/payments/refund.ts': 'export function refund(amount: number, reason: string) {\n  return gateway.refund(amount);\n}\n' });
      repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD~1');

      const result = await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json', '--strict-coverage']);

      expect(result.exitCode).toBe(0);
      expect(client.requests).toHaveLength(0);
      expect(json(result).exclusions).toEqual([{ path: 'src/payments/refund.ts', reason: 'no-line-changes' }]);
    });

    it('documents the severities in order', () => {
      expect(tables('Severities')[0].map((row) => code(row.Severity))).toEqual([...CHECK_SEVERITIES]);
    });

    it('documents every key of the JSON result and when it is present', async () => {
      const [keys, findingFields, summaryFields, coverageFields] = tables('JSON result');
      const present = (...when: string[]) => keys.filter((row) => when.some((text) => row.Present.includes(text))).map((row) => code(row.Key));

      const ok = json(await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json']));
      const early = json(await runDocumented(repo, ['dhruv', 'check', '--base', 'no-such-branch', '--json']));
      setAIClient(new FakeClient(() => { throw { kind: 'connection', cause: 'ECONNREFUSED' }; }));
      const late = json(await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json']));

      expect(Object.keys(ok)).toEqual(present('always', 'once the range was read', '`ok`'));
      expect(Object.keys(early)).toEqual(present('always', '`error`'));
      expect(Object.keys(late)).toEqual(present('always', 'once the range was read', '`error`'));

      const flat = (value: Json, prefix = ''): string[] => Object.entries(value).flatMap(([key, nested]) =>
        key === 'omitted' ? flat(nested as Json, `${key}.`) : [`${prefix}${key}`]);
      expect(findingFields.map((row) => code(row.Field))).toEqual(Object.keys(ok.findings[0]));
      expect(summaryFields.map((row) => code(row.Field))).toEqual(flat(ok.summary));
      expect(coverageFields.map((row) => code(row.Field))).toEqual(Object.keys(ok.coverage));
    });

    it('documents the exit code of every status, as real runs produce them', async () => {
      const [rows] = tables('Exit codes');
      const documented = Object.fromEntries(rows.map((row) => [code(row.status), Number(code(row['Exit code']))]));
      expect(Object.values(documented).sort()).toEqual(Object.values(CHECK_EXIT).sort());

      const runs = [
        await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json']),
        await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json', '--max-file-bytes', '1']),
        await runDocumented(repo, ['dhruv', 'check', '--base', 'origin/main', '--json', '--max-file-bytes', '1', '--strict-coverage']),
        await runDocumented(repo, ['dhruv', 'check', '--base', 'no-such-branch', '--json']),
      ];

      expect(runs.map((run) => json(run).status)).toEqual(['ok', 'ok', 'incomplete', 'error']);
      for (const run of runs) expect(run.exitCode).toBe(documented[json(run).status]);
    });

    it('documents the exit code and status of a cancelled run', async () => {
      const [rows] = tables('Exit codes');
      const cancelled = rows.find((row) => code(row.status) === 'cancelled');
      setAIClient(new FakeClient(() => new Promise<string>(() => undefined)));
      setSessionConfig({ ...RUN_DEFAULTS, responseFormat: 'json' });
      const stdout: string[] = [];
      const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });

      try {
        const running = check({ base: 'origin/main' }, { cwd: repo.root });
        await new Promise((resolve) => setTimeout(resolve, 50));
        process.emit('SIGINT');
        await running;
      } finally {
        outSpy.mockRestore();
      }

      expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'cancelled', error: { kind: 'ai-cancelled' } });
      expect(process.exitCode).toBe(Number(code(cancelled?.['Exit code'] ?? '')));
    });

    it('documents the error kinds that runs report', async () => {
      const documented = tables('Error kinds')[0].map((row) => code(row['error.kind']));
      const kindOf = async (words: string[]) => json(await runDocumented(repo, ['dhruv', 'check', '--json', ...words])).error.kind as string;

      const kinds = [await kindOf([]), await kindOf(['--base', 'no-such-branch']), await kindOf(['--base', 'origin/main', '--min-severity', 'urgent'])];
      setAIClient(new FakeClient(() => 'I could not find any problems.'));
      kinds.push(await kindOf(['--base', 'origin/main']));
      for (const failure of ['connection', 'model-not-found', 'empty-response', 'timeout', 'request']) {
        setAIClient(new FakeClient(() => { throw { kind: failure }; }));
        kinds.push(await kindOf(['--base', 'origin/main']));
      }
      repo.commit({ [CHECK_POLICY_FILE]: '{ "schemaVersion": 2 }' });
      kinds.push(await kindOf(['--base', 'origin/main']));

      expect(new Set(kinds).size).toBe(9);
      for (const kind of kinds) expect(documented).toContain(kind);
      expect(new Set(documented).size).toBe(documented.length);
    });
  });

  describe('GitHub Actions example', () => {
    const steps = () => workflow().jobs.check.steps;
    const stepUsing = (action: string) => steps().find((step) => step.uses?.startsWith(`${action}@`));
    const reviewStep = () => steps().find((step) => /\bdhruv\b/.test(step.run ?? '') && /\bcheck\b/.test(step.run ?? ''));
    const reviewCommand = () => checkCommands(reviewStep()?.run ?? '', workflowEnv)[0];

    it('is documentation only: this repository does not run it', () => {
      const own = fs.readdirSync(path.join(project, '.github/workflows')).map((name) => read(`.github/workflows/${name}`));

      for (const text of own) expect(text).not.toMatch(/dhruv\s+check/);
    });

    it('checks out the pull request with full history and no credentials, on a trusted runner', () => {
      const config = workflow();

      expect(Object.keys(config.on)).toEqual(['pull_request']);
      expect(config.permissions).toEqual({ contents: 'read' });
      expect(config.jobs.check['runs-on']).toContain('self-hosted');
      expect(stepUsing('actions/checkout')?.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
      expect(String(stepUsing('actions/checkout')?.with?.ref)).toContain('pull_request.head.sha');
    });

    it('configures the endpoint and model, and passes them so the checkout cannot replace them', () => {
      const { env } = workflow().jobs.check;
      const { words } = reviewCommand();

      expect(env.OLLAMA_HOST).toBeTruthy();
      expect(words.slice(0, 2)).toEqual(['dhruv', 'check']);
      expect(words.slice(words.indexOf('--base'), words.indexOf('--base') + 2)).toEqual(['--base', 'origin/main']);
      expect(words.slice(words.indexOf('--model'), words.indexOf('--model') + 2)).toEqual(['--model', 'ci-model']);
      expect(words).toEqual(expect.arrayContaining(['--json', '--timeout', '--strict-coverage']));
      // The base branch name reaches the shell as data, never as script text.
      expect(reviewStep()?.run).not.toContain('${{');
    });

    it('runs nothing from the repository under review', () => {
      const commands = steps().flatMap((step) => (step.run ?? '').replace(/\\\n/g, ' ').split('\n')).map((line) => line.trim()).filter(Boolean);
      const install = steps().find((step) => /\bnpm\b/.test(step.run ?? ''));

      for (const command of commands) expect(command).toMatch(/^(npm install --global @rahul05ranjan\/dhruv-cli(@\S+)?$|dhruv check |rm -f logs\/|rmdir logs )/);
      expect(install?.['working-directory']).toContain('runner.temp');
      for (const step of steps()) if (step.uses) expect(step.uses).toMatch(/^actions\/(checkout|setup-node|upload-artifact)@v\d+$/);
    });

    it('keeps the JSON result as an artifact and out of the job log', () => {
      const { redirect } = reviewCommand();
      const upload = stepUsing('actions/upload-artifact');
      const runnerTemp = (value: string) => value.replace('${{ runner.temp }}', workflowEnv.RUNNER_TEMP);

      expect(redirect).toBe(`${workflowEnv.RUNNER_TEMP}/dhruv-check.json`);
      expect(runnerTemp(String(upload?.with?.path))).toBe(redirect);
      expect(upload?.if).toBe('always()');
      // Only the redirect names the result: no step prints or post-processes it.
      const mentions = steps().filter((step) => (step.run ?? '').includes('dhruv-check.json'));
      expect(mentions).toEqual([reviewStep()]);
      for (const step of steps()) expect(step.run ?? '').not.toMatch(/\b(cat|echo|tee|jq|printf)\b/);
    });

    describe('run for real against a stand-in Ollama service', () => {
      const entry = path.resolve(project, 'src/index.ts');
      const loader = pathToFileURL(path.resolve(project, 'node_modules/ts-node/esm.mjs')).href;
      let server: http.Server;
      let requests: Array<{ url?: string; body: string }>;

      beforeEach(async () => {
        requests = [];
        server = http.createServer((request, response) => {
          let body = '';
          request.on('data', (chunk) => { body += chunk; });
          request.on('end', () => {
            requests.push({ url: request.url, body });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ response: EXAMPLE_REPLY }));
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      });

      afterEach(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });

      it('reviews through OLLAMA_HOST, runs no plugin, and leaves only its log files behind', async () => {
        repo.remove();
        // A checkout that tries everything the guide says a pull request controls.
        repo = exampleRepo({
          'plugins/marker.js': 'import { writeFileSync } from "node:fs"; writeFileSync("plugin-executed", "yes");\n',
          '.dhruv-config.json': JSON.stringify({ model: 'model-from-the-checkout', timeoutMs: 1, responseFormat: 'text' }),
        });
        const { words } = reviewCommand();

        const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--loader', loader, entry, ...words.slice(1)], {
            cwd: repo.root,
            env: {
              ...process.env,
              TS_NODE_PROJECT: path.resolve(project, 'tsconfig.json'),
              OLLAMA_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => { stdout += chunk; });
          child.stderr.on('data', (chunk) => { stderr += chunk; });
          child.on('error', reject);
          child.on('close', (status) => resolve({ status, stdout, stderr }));
        });

        // The documented outcome: exit 0 and one JSON object on stdout, asked of the configured endpoint and model.
        expect(run.status).toBe(0);
        const parsed = JSON.parse(run.stdout) as Json;
        expect(run.stdout.trim().split('\n')).toHaveLength(1);
        expect(parsed).toMatchObject({ schemaVersion: 1, command: 'check', status: 'ok', model: 'ci-model', refs: { base: { ref: 'origin/main' } } });
        expect(parsed.findings).toHaveLength(1);
        expect(requests.map((request) => request.url)).toEqual(['/api/generate']);
        expect(JSON.parse(requests[0].body)).toMatchObject({ model: 'ci-model' });
        expect(requests[0].body).toContain('SOURCE_MARKER');

        // Nothing from the checkout ran, and neither the patch nor the raw response leaked.
        expect(fs.existsSync(path.join(repo.root, 'plugin-executed'))).toBe(false);
        expect(run.stderr).not.toContain('SOURCE_MARKER');
        expect(run.stderr).not.toContain('RESPONSE_MARKER');
        expect(run.stdout).not.toContain('SOURCE_MARKER');
        expect(run.stdout).not.toContain('RESPONSE_MARKER');

        // The only thing written is logs/, and the workflow's last step removes exactly those files.
        expect(repo.git('status', '--porcelain', '--ignored')).toBe('?? logs/');
        const cleanup = steps().find((step) => /\brm -f\b/.test(step.run ?? ''))?.run ?? '';
        const removed = (/rm -f (.+)/.exec(cleanup)?.[1] ?? '').split(' ').map((glob) =>
          new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`));
        const logFiles = fs.readdirSync(path.join(repo.root, 'logs'));
        expect(logFiles.length).toBeGreaterThan(0);
        for (const file of logFiles) {
          expect(removed.some((pattern) => pattern.test(`logs/${file}`))).toBe(true);
          const content = fs.readFileSync(path.join(repo.root, 'logs', file), 'utf8');
          expect(content).not.toContain('SOURCE_MARKER');
          expect(content).not.toContain('RESPONSE_MARKER');
        }
      }, 60000);
    });
  });
});
