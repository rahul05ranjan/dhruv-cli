import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { review } from '../src/commands/review';
import { securityCheck } from '../src/commands/security-check';
import { generate } from '../src/commands/generate';
import { optimize } from '../src/commands/optimize';
import { setAIClient } from '../src/core/ai';
import type { AIClient, AIRequest } from '../src/core/ai';

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

class RecordingClient implements AIClient {
  requests: AIRequest[] = [];

  async ask(request: AIRequest): Promise<string> {
    this.requests.push(request);
    return 'review complete';
  }

  async listModels(): Promise<string[]> {
    return ['test-model'];
  }
}

describe('file analysis commands', () => {
  let root: string;
  let client: RecordingClient;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dhruv-review-'));
    client = new RecordingClient();
    setAIClient(client);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reviews nested source files without sending dependency directories', async () => {
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'library'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'nested', 'feature.ts'), 'export const feature = true;');
    fs.writeFileSync(path.join(root, 'node_modules', 'library', 'ignored.ts'), 'export const ignored = true;');

    await review(root);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].prompt).toContain('src/nested/feature.ts');
    expect(client.requests[0].prompt).not.toContain('node_modules/library/ignored.ts');
  });

  it('excludes build and framework cache directories during recursive review', async () => {
    fs.mkdirSync(path.join(root, '.next'), { recursive: true });
    fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, '.next', 'bundle.js'), 'console.log("cached");');
    fs.writeFileSync(path.join(root, 'vendor', 'lib.go'), 'package vendor');
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const main = 1;');

    await review(root);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].prompt).toContain('src/main.ts');
    expect(client.requests[0].prompt).not.toContain('.next/bundle.js');
    expect(client.requests[0].prompt).not.toContain('vendor/lib.go');
  });

  it('includes detected project context in review requests', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export const value = 1;');

    await review(root);

    expect(client.requests[0].prompt).toContain('node-typescript');
  });

  it('reviews a single file and includes its content', async () => {
    const single = path.join(root, 'index.ts');
    fs.writeFileSync(single, 'export const single = true;');

    await review(single);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].prompt).toContain('export const single = true;');
  });

  it('sets failing exit code when reviewing a nonexistent path', async () => {
    process.exitCode = undefined;
    try {
      await review(path.join(root, 'nonexistent.ts'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('redacts credential-like values before security analysis', async () => {
    const source = path.join(root, 'config.ts');
    fs.writeFileSync(source, 'const API_KEY = "sk-live-super-secret";');

    await securityCheck(source);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].prompt).not.toContain('sk-live-super-secret');
    expect(client.requests[0].prompt).toContain('[REDACTED]');
  });

  it('includes location and remediation for deterministic security findings', async () => {
    const source = path.join(root, 'config.ts');
    fs.writeFileSync(source, 'const API_KEY = "sk-live-super-secret";');

    await securityCheck(source);

    expect(client.requests[0].prompt).toContain('line 1');
    expect(client.requests[0].prompt).toContain('rotate the credential');
  });

  it('redacts GitHub tokens and AWS keys with remediation guidance', async () => {
    const source = path.join(root, 'secrets.ts');
    fs.writeFileSync(source, 'const GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";\nconst AWS_KEY = "AKIA1234567890ABCDEF";');

    await securityCheck(source);

    expect(client.requests[0].prompt).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(client.requests[0].prompt).not.toContain('AKIA1234567890ABCDEF');
    expect(client.requests[0].prompt).toContain('GitHub token detected');
    expect(client.requests[0].prompt).toContain('AWS access key ID detected');
  });

  it('scans nested project files without sending dependency directories', async () => {
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'library'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'nested', 'config.ts'), 'const API_KEY = "sk-live-super-secret";');
    fs.writeFileSync(path.join(root, 'node_modules', 'library', 'ignored.ts'), 'const API_KEY = "sk-dependency-secret";');

    await securityCheck(root);

    expect(client.requests[0].prompt).toContain('src/nested/config.ts');
    expect(client.requests[0].prompt).not.toContain('sk-dependency-secret');
  });

  it('reports accurate per-file line numbers for security findings in multi-file scans', async () => {
    // first.ts has 20 benign lines
    const benignLines = Array(20).fill('// harmless line').join('\n');
    fs.writeFileSync(path.join(root, '01_first.ts'), benignLines);

    // 02_second.ts has secret on line 2
    fs.writeFileSync(path.join(root, '02_second.ts'), '// harmless header\nconst API_KEY = "sk-live-second-file-secret";\n');

    await securityCheck(root);

    expect(client.requests[0].prompt).toContain('in 02_second.ts at line 2:');
    expect(client.requests[0].prompt).not.toContain('line 22');
    expect(client.requests[0].prompt).not.toContain('line 23');
    expect(client.requests[0].prompt).not.toContain('line 24');
  });

  it('sets a failing exit code in strict mode for high-confidence findings', async () => {
    const source = path.join(root, 'unsafe.ts');
    fs.writeFileSync(source, 'const API_KEY = "sk-live-super-secret";');
    process.exitCode = undefined;

    try {
      await securityCheck(source, { strict: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('does not overwrite an existing generated file', async () => {
    const source = path.join(root, 'sample.ts');
    const generated = path.join(root, 'sample.test.ts');
    fs.writeFileSync(source, 'export const value = 1;');
    fs.writeFileSync(generated, 'keep this work');

    await generate('tests', source, { apply: true });

    expect(fs.readFileSync(generated, 'utf8')).toBe('keep this work');
  });

  it('preserves the target language when generating tests', async () => {
    const source = path.join(root, 'sample.ts');
    fs.writeFileSync(source, 'export const value = 1;');

    await generate('tests', source, { apply: true });

    expect(fs.existsSync(path.join(root, 'sample.test.ts'))).toBe(true);
  });

  it('preserves the Python language and conventions when generating tests', async () => {
    const source = path.join(root, 'math_utils.py');
    fs.writeFileSync(source, 'def add(a, b):\n    return a + b\n');

    await generate('tests', source, { apply: true });

    expect(client.requests[0].prompt).toContain('Python code');
    expect(client.requests[0].prompt).toContain('pytest');
    expect(fs.existsSync(path.join(root, 'math_utils.test.py'))).toBe(true);
  });

  it('previews generated tests without writing by default', async () => {
    const source = path.join(root, 'preview.ts');
    fs.writeFileSync(source, 'export const value = 1;');

    await generate('tests', source);

    expect(fs.existsSync(path.join(root, 'preview.test.ts'))).toBe(false);
  });

  it('asks optimization responses to explain impact and trade-offs', async () => {
    const source = path.join(root, 'sample.ts');
    fs.writeFileSync(source, 'export const value = 1;');

    await optimize(source);

    expect(client.requests[0].prompt).toContain('expected impact');
    expect(client.requests[0].prompt).toContain('trade-offs');
  });

  it('sets failing exit code when generating for a nonexistent path', async () => {
    process.exitCode = undefined;
    try {
      await generate('tests', path.join(root, 'nonexistent.ts'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('sets failing exit code when optimizing a nonexistent path', async () => {
    process.exitCode = undefined;
    try {
      await optimize(path.join(root, 'nonexistent.ts'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });
});

