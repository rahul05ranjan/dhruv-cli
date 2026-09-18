import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  ask,
  listModels,
  setAIClient,
  InMemoryAIClient,
} from '../src/core/ai';
import { loadConfig, saveConfig } from '../src/config/config';
import { createSpinner } from '../src/utils/ux';
import { detectProjectType } from '../src/utils/projectType';
import { getSystemMessage } from '../src/core/prompts';
import { runCommand } from '../src/core/command-runner';
import fs from 'fs';
import path from 'path';

// chalk and ora are ESM-only and can't be loaded by the CJS test runtime.
// Identity stubs stand in: the tests assert pipeline behavior, not coloring.
jest.mock('chalk', () => {
  // Self-chaining identity: chalk.green.bold('x') === 'x', any chain depth.
  const identity = (s: unknown) => String(s);
  const makeChalk = (): unknown =>
    new Proxy(identity, {
      get: (_target: unknown, prop: string | symbol) => {
        if (prop === 'level') return 0;
        if (prop === Symbol.toPrimitive) return () => '';
        return makeChalk();
      },
      apply: (_target: unknown, _thisArg: unknown, args: unknown[]) => String(args[0]),
    });
  const chalk = makeChalk() as unknown as Record<string, unknown>;
  return { __esModule: true, default: chalk, ...chalk };
});

jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
  })),
}));

// UX output is mocked at its own module edge — the runner's pipeline behavior
// is what's under test, not console formatting.
jest.mock('../src/utils/ux', () => ({
  printError: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  createSpinner: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
  })),
  themed: jest.fn((text: string) => text),
  highlightCode: jest.fn((code: string) => code),
  createProgressBar: jest.fn(() => ({
    increment: jest.fn(),
    stop: jest.fn(),
  })),
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

describe('Dhruv CLI Core Systems', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Configuration Management', () => {
    it('should load default configuration', () => {
      const config = loadConfig();
      expect(config).toHaveProperty('model');
      expect(config).toHaveProperty('verbose');
      expect(config).toHaveProperty('responseFormat');
      expect(config).toHaveProperty('theme');
    });

    it('should validate and merge configuration', () => {
      const testConfig = {
        model: 'test-model',
        verbose: true,
        responseFormat: 'json' as const,
        theme: 'dark' as const,
      };

      saveConfig(testConfig);
      const loadedConfig = loadConfig();

      expect(loadedConfig.model).toBe('test-model');
      expect(loadedConfig.verbose).toBe(true);
      expect(loadedConfig.responseFormat).toBe('json');
      expect(loadedConfig.theme).toBe('dark');
    });

    it('should handle invalid configuration gracefully', () => {
      const configPath = path.join(process.cwd(), '.dhruv-config.json');
      fs.writeFileSync(configPath, 'invalid json');

      const config = loadConfig();

      expect(config).toHaveProperty('model');
      expect(config.verbose).toBe(false);

      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    });
  });

  describe('Project Type Detection', () => {
    it('should detect Node.js project', () => {
      const mockExistsSync = jest.spyOn(fs, 'existsSync');
      mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
        return path.basename(filePath.toString()) === 'package.json';
      });

      const mockReadFileSync = jest.spyOn(fs, 'readFileSync');
      mockReadFileSync.mockReturnValue(JSON.stringify({
        name: 'test-project',
        dependencies: { express: '^4.0.0' }
      }));

      const projectType = detectProjectType();
      expect(projectType).toBe('node-express');

      mockExistsSync.mockRestore();
      mockReadFileSync.mockRestore();
    });

    it('should detect React project', () => {
      const mockExistsSync = jest.spyOn(fs, 'existsSync');
      mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
        const basename = path.basename(filePath.toString());
        return basename === 'package.json' || basename === 'src';
      });

      const mockReadFileSync = jest.spyOn(fs, 'readFileSync');
      mockReadFileSync.mockReturnValue(JSON.stringify({
        name: 'test-react-app',
        dependencies: { 'react': '^18.0.0', 'react-dom': '^18.0.0' }
      }));

      const projectType = detectProjectType();
      expect(projectType).toBe('react');

      mockExistsSync.mockRestore();
      mockReadFileSync.mockRestore();
    });

    it('should return unknown for unrecognized projects', () => {
      const mockExistsSync = jest.spyOn(fs, 'existsSync');
      mockExistsSync.mockReturnValue(false);

      const projectType = detectProjectType();
      expect(projectType).toBe('unknown');

      mockExistsSync.mockRestore();
    });

    it('should detect a TypeScript Node project', () => {
      const mockExistsSync = jest.spyOn(fs, 'existsSync');
      mockExistsSync.mockImplementation((filePath: fs.PathLike) => path.basename(filePath.toString()) === 'package.json');
      const mockReadFileSync = jest.spyOn(fs, 'readFileSync');
      mockReadFileSync.mockReturnValue(JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }));

      expect(detectProjectType()).toBe('node-typescript');

      mockExistsSync.mockRestore();
      mockReadFileSync.mockRestore();
    });

    it('should return unknown instead of throwing for malformed package metadata', () => {
      const mockExistsSync = jest.spyOn(fs, 'existsSync');
      mockExistsSync.mockImplementation((filePath: fs.PathLike) => path.basename(filePath.toString()) === 'package.json');
      const mockReadFileSync = jest.spyOn(fs, 'readFileSync');
      mockReadFileSync.mockReturnValue('{ malformed');

      expect(detectProjectType()).toBe('unknown');

      mockExistsSync.mockRestore();
      mockReadFileSync.mockRestore();
    });
  });

  describe('System Message Templates', () => {
    it('should return system message for valid type', () => {
      const explainMessage = getSystemMessage('explain');
      expect(explainMessage).toContain('programming instructor');
      expect(explainMessage).toContain('technical expert');

      const suggestMessage = getSystemMessage('suggest');
      expect(suggestMessage).toContain('software architect');
      expect(suggestMessage).toContain('best practices');
    });

    it('should return default message for invalid type', () => {
      const defaultMessage = getSystemMessage('invalid');
      const explainMessage = getSystemMessage('explain');
      expect(defaultMessage).toBe(explainMessage);
    });
  });

  describe('AI module through its interface (in-memory adapter)', () => {
    let client: InMemoryAIClient;

    beforeEach(() => {
      client = new InMemoryAIClient(new Map([['hello', 'cached answer']]));
      setAIClient(client);
    });

    it('streams tokens and returns the full response', async () => {
      const tokens: string[] = [];
      const response = await ask({ prompt: 'hello', onToken: (t) => tokens.push(t) });
      expect(response).toBe('cached answer');
      expect(tokens).toEqual(['cached answer']);
    });

    it('returns the same response for a repeated request without recomputing', async () => {
      const first = await ask({ prompt: 'hello' });
      const second = await ask({ prompt: 'hello' });
      expect(first).toBe(second);
      expect(client.computations).toBe(1);
    });

    it('recomputes when the cache entry expires', async () => {
      await ask({ prompt: 'hello' });
      const before = client.computations;

      // Simulate the entry aging past the TTL.
      const originalNow = client.now;
      client.now = () => originalNow() + 25 * 60 * 60 * 1000;

      await ask({ prompt: 'hello' });
      expect(client.computations).toBe(before + 1);
    });

    it('surfaces model-not-found as a typed error', async () => {
      client.failures.set('missing-model', { kind: 'model-not-found', model: 'nope' });
      await expect(ask({ prompt: 'missing-model please' })).rejects.toMatchObject({
        kind: 'model-not-found',
      });
    });

    it('surfaces connection failure as a typed error', async () => {
      client.failures.set('down', { kind: 'connection', cause: 'ECONNREFUSED' });
      await expect(ask({ prompt: 'down service' })).rejects.toMatchObject({
        kind: 'connection',
      });
    });

    it('lists models through the interface', async () => {
      const models = await listModels();
      expect(models).toContain('test-model');
    });
  });

  describe('Command runner through its seam (fake AI adapter injected)', () => {
    let client: InMemoryAIClient;

    beforeEach(() => {
      client = new InMemoryAIClient(new Map([['happy', 'the answer']]));
      setAIClient(client);
    });

    function makeSpec(overrides: Partial<Parameters<typeof runCommand>[0]> = {}) {
      return {
        name: 'explain',
        input: { query: 'happy' },
        header: '📚 Explanation: ',
        buildRequest: (input: Record<string, string>, model: string) => ({
          prompt: input.query,
          systemMessage: 'sys',
          model,
        }),
        ...overrides,
      };
    }

    it('runs the full pipeline for a happy path', async () => {
      let completed: string | undefined;
      await runCommand(makeSpec({ onComplete: (response) => { completed = response; } }));
      expect(completed).toBe('the answer');
    });

    it('shows the AI response to the user', async () => {
      const output: string[] = [];
      const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });

      await runCommand(makeSpec());

      expect(output.join('')).toContain('the answer');
      write.mockRestore();
    });

    it('emits one structured result in JSON mode', async () => {
      saveConfig({ responseFormat: 'json' });
      const output: string[] = [];
      const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });

      try {
        await runCommand(makeSpec());
        const result = JSON.parse(output.join('')) as Record<string, unknown>;
        expect(result).toMatchObject({
          ok: true,
          command: 'explain',
          response: 'the answer',
        });
      } finally {
        write.mockRestore();
        saveConfig({ responseFormat: 'text' });
      }
    });

    it('short-circuits on validation failure before the AI call', async () => {
      const computationsBefore = client.computations;
      await runCommand(makeSpec({ input: { query: '<script>alert(1)</script>' } }));
      expect(client.computations).toBe(computationsBefore);
    });

    it('maps a typed connection error to the ollama-serve hint', async () => {
      client.failures.set('happy', { kind: 'connection', cause: 'ECONNREFUSED' });
      await runCommand(makeSpec());
      const { printError } = await import('../src/utils/ux');
      expect(jest.mocked(printError).mock.calls.length).toBeGreaterThan(0);
    });

    it('maps a typed model-not-found error to the pull hint', async () => {
      client.failures.set('happy', { kind: 'model-not-found', model: 'nope' });
      await runCommand(makeSpec());
      const { printError } = await import('../src/utils/ux');
      expect(jest.mocked(printError).mock.calls.length).toBeGreaterThan(0);
    });

    it('maps an untyped ECONNREFUSED error to the ollama-serve hint', async () => {
      setAIClient({
        ask: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
        listModels: async () => [],
      });
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await runCommand(makeSpec());
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ollama serve'));
      consoleSpy.mockRestore();
    });

    it('displays completed response when streaming is unavailable', async () => {
      setAIClient({
        ask: async () => 'static completed response',
        listModels: async () => [],
      });
      const output: string[] = [];
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });
      await runCommand(makeSpec());
      expect(output.join('')).toContain('static completed response');
      writeSpy.mockRestore();
    });

    it('marks the process unsuccessful when an AI command fails', async () => {
      const originalExitCode = process.exitCode;
      process.exitCode = undefined;
      client.failures.set('happy', { kind: 'connection', cause: 'ECONNREFUSED' });

      try {
        await runCommand(makeSpec());
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = originalExitCode;
      }
    });

    it('treats an empty AI response as a failed command', async () => {
      setAIClient(new InMemoryAIClient(new Map([['happy', '']])));
      process.exitCode = undefined;

      try {
        await runCommand(makeSpec());
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = undefined;
      }
    });

    it('times out a long-running AI request with a failing exit code', async () => {
      saveConfig({ timeoutMs: 5 });
      setAIClient({
        ask: () => new Promise<string>(() => {}),
        listModels: async () => [],
      });
      process.exitCode = undefined;

      try {
        await runCommand(makeSpec());
        expect(process.exitCode).toBe(1);
      } finally {
        saveConfig({ timeoutMs: 45000 });
        process.exitCode = undefined;
      }
    });

    it('cancels an in-flight request on Ctrl-C', async () => {
      saveConfig({ timeoutMs: 1000 });
      setAIClient({
        ask: () => new Promise<string>(() => {}),
        listModels: async () => [],
      });
      process.exitCode = undefined;

      try {
        const running = runCommand(makeSpec());
        await new Promise((resolve) => setTimeout(resolve, 5));
        process.emit('SIGINT');
        await running;
        expect(process.exitCode).toBe(130);
      } finally {
        saveConfig({ timeoutMs: 45000 });
        process.exitCode = undefined;
      }
    });
  });

  describe('UX Utilities', () => {
    it('should create spinner correctly', () => {
      const spinner = createSpinner('Testing...');
      expect(spinner).toHaveProperty('start');
      expect(spinner).toHaveProperty('stop');
    });
  });
});
