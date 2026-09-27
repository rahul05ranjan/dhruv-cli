import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { saveConfig } from '../src/config/config';
import { status } from '../src/commands/status';
import { health } from '../src/commands/health';
import { metrics } from '../src/commands/metrics';
import { takeRuntimeDiagnosticSnapshot } from '../src/core/runtime-diagnostic';
import { getOllamaStatus, listModels } from '../src/core/ai';
import { metricsCollector } from '../src/core/metrics';

jest.mock('chalk', () => {
  const identity = (value: unknown) => String(value);
  const makeChalk = (): unknown => new Proxy(identity, {
    get: (_target, property: string | symbol) => property === 'level' ? 0 : makeChalk(),
    apply: (_target, _thisArg, args: unknown[]) => String(args[0]),
  });
  const chalk = makeChalk() as Record<string, unknown>;
  return { __esModule: true, default: chalk, ...chalk };
});

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

jest.mock('../src/core/ai', () => ({
  listModels: jest.fn(),
  getOllamaStatus: jest.fn(),
}));

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logInfo: jest.fn(),
  logError: jest.fn(),
}));

describe('Runtime Diagnostic Readiness & Presentation Contract', () => {
  let stdoutChunks: string[] = [];
  let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let memorySpy: jest.SpiedFunction<typeof process.memoryUsage>;

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    memorySpy = jest.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 40 * 1024 * 1024,
      heapTotal: 30 * 1024 * 1024,
      heapUsed: 20 * 1024 * 1024,
      external: 1024 * 1024,
      arrayBuffers: 0,
    });
    process.exitCode = 0;
    jest.clearAllMocks();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    memorySpy.mockRestore();
    saveConfig({ responseFormat: 'text', model: 'test-model' });
    process.exitCode = 0;
  });

  describe('Single source of truth (takeRuntimeDiagnosticSnapshot)', () => {
    it('evaluates ready state when model is present in available models', async () => {
      jest.mocked(listModels).mockResolvedValue(['test-model', 'other-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model' });

      const snapshot = await takeRuntimeDiagnosticSnapshot();

      expect(snapshot).toMatchObject({
        configuredModel: 'test-model',
        availableModels: ['test-model', 'other-model'],
        endpoint: 'http://127.0.0.1:11434',
        version: '0.12.3',
        ollama: 'connected',
        configuredModelAvailable: true,
        ready: true,
        nextSteps: [],
      });
    });

    it('evaluates unready state when model is missing from available models', async () => {
      jest.mocked(listModels).mockResolvedValue(['other-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model' });

      const snapshot = await takeRuntimeDiagnosticSnapshot();

      expect(snapshot).toMatchObject({
        configuredModel: 'test-model',
        availableModels: ['other-model'],
        ollama: 'connected',
        configuredModelAvailable: false,
        ready: false,
        nextSteps: ['ollama pull test-model'],
      });
    });

    it('evaluates unavailable state when Ollama daemon cannot be reached', async () => {
      jest.mocked(listModels).mockRejectedValue(new Error('ECONNREFUSED'));
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434' });
      saveConfig({ model: 'test-model' });

      const snapshot = await takeRuntimeDiagnosticSnapshot();

      expect(snapshot).toMatchObject({
        configuredModel: 'test-model',
        availableModels: [],
        ollama: 'unavailable',
        configuredModelAvailable: false,
        ready: false,
        error: 'ECONNREFUSED',
        nextSteps: ['ollama serve', 'ollama pull test-model'],
      });
    });
  });

  describe('Agreement between health and status on readiness in JSON mode', () => {
    it('both agree on ready state (exitCode 0, ok: true)', async () => {
      jest.mocked(listModels).mockResolvedValue(['test-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'json' });

      // Run status
      stdoutChunks = [];
      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode ?? 0;
      const statusJson = JSON.parse(stdoutChunks.join('')) as { ok: boolean; command: string };

      // Run health
      stdoutChunks = [];
      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode ?? 0;
      const healthJson = JSON.parse(stdoutChunks.join('')) as {
        ok: boolean;
        command: string;
        results: Array<{ category: string; status: string }>;
      };

      expect(statusExit).toBe(0);
      expect(healthExit).toBe(0);
      expect(statusJson.ok).toBe(true);
      expect(healthJson.ok).toBe(true);

      const aiCheck = healthJson.results.find((r) => r.category === 'AI Service');
      expect(aiCheck?.status).toBe('pass');
    });

    it('both agree on unready state when configured model is missing (exitCode 1, ok: false)', async () => {
      jest.mocked(listModels).mockResolvedValue(['other-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'json' });

      // Run status
      stdoutChunks = [];
      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode;
      const statusJson = JSON.parse(stdoutChunks.join('')) as {
        ok: boolean;
        command: string;
        configuredModelAvailable: boolean;
      };

      // Run health
      stdoutChunks = [];
      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode;
      const healthJson = JSON.parse(stdoutChunks.join('')) as {
        ok: boolean;
        command: string;
        results: Array<{ category: string; status: string }>;
      };

      expect(statusExit).toBe(1);
      expect(healthExit).toBe(1);
      expect(statusJson.ok).toBe(false);
      expect(statusJson.configuredModelAvailable).toBe(false);
      expect(healthJson.ok).toBe(false);

      const aiCheck = healthJson.results.find((r) => r.category === 'AI Service');
      expect(aiCheck?.status).toBe('fail');
    });

    it('both agree on failure state when Ollama daemon is unavailable (exitCode 1, ok: false)', async () => {
      jest.mocked(listModels).mockRejectedValue(new Error('connection refused'));
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434' });
      saveConfig({ model: 'test-model', responseFormat: 'json' });

      // Run status
      stdoutChunks = [];
      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode;
      const statusJson = JSON.parse(stdoutChunks.join('')) as { ok: boolean; command: string; ollama: string };

      // Run health
      stdoutChunks = [];
      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode;
      const healthJson = JSON.parse(stdoutChunks.join('')) as {
        ok: boolean;
        command: string;
        results: Array<{ category: string; status: string }>;
      };

      expect(statusExit).toBe(1);
      expect(healthExit).toBe(1);
      expect(statusJson.ok).toBe(false);
      expect(statusJson.ollama).toBe('unavailable');
      expect(healthJson.ok).toBe(false);

      const aiCheck = healthJson.results.find((r) => r.category === 'AI Service');
      expect(aiCheck?.status).toBe('fail');
    });
  });

  describe('Agreement between health and status on readiness in Text mode', () => {
    it('both agree on ready exitCode 0 in text mode', async () => {
      jest.mocked(listModels).mockResolvedValue(['test-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'text' });

      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode ?? 0;

      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode ?? 0;

      expect(statusExit).toBe(0);
      expect(healthExit).toBe(0);
    });

    it('both agree on failing exitCode 1 in text mode when model is missing', async () => {
      jest.mocked(listModels).mockResolvedValue(['other-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'text' });

      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode;

      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode;

      expect(statusExit).toBe(1);
      expect(healthExit).toBe(1);
    });

    it('both agree on failing exitCode 1 in text mode when Ollama is unreachable', async () => {
      jest.mocked(listModels).mockRejectedValue(new Error('daemon stopped'));
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434' });
      saveConfig({ model: 'test-model', responseFormat: 'text' });

      process.exitCode = 0;
      await status();
      const statusExit = process.exitCode;

      process.exitCode = 0;
      await health();
      const healthExit = process.exitCode;

      expect(statusExit).toBe(1);
      expect(healthExit).toBe(1);
    });
  });

  describe('Host checks and metrics isolation contract', () => {
    it('health preserves comprehensive host check categories beyond AI service', async () => {
      jest.mocked(listModels).mockResolvedValue(['test-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'json' });

      stdoutChunks = [];
      await health();
      const result = JSON.parse(stdoutChunks.join('')) as {
        results: Array<{ category: string }>;
      };

      const categories = new Set(result.results.map((r) => r.category));
      expect(categories).toContain('Configuration');
      expect(categories).toContain('Dependencies');
      expect(categories).toContain('AI Service');
      expect(categories).toContain('Security');
      expect(categories).toContain('Performance');
      expect(categories).toContain('File System');
      expect(categories).toContain('Plugins');
    });

    it('diagnostics do not mutate persistent command or model metrics', async () => {
      metricsCollector.resetPersistent();
      jest.mocked(listModels).mockResolvedValue(['test-model']);
      jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
      saveConfig({ model: 'test-model', responseFormat: 'json' });

      await status();
      await health();

      const summary = metricsCollector.getSummary();
      expect(summary.commands).toEqual({});
      expect(summary.models).toEqual({});

      // metrics command retains independent reporting
      stdoutChunks = [];
      metricsCollector.recordCommand('status', 40, true);
      await metrics();
      const metricsJson = JSON.parse(stdoutChunks.join('')) as {
        ok: boolean;
        command: string;
        summary: { commands: Record<string, unknown> };
      };
      expect(metricsJson.ok).toBe(true);
      expect(metricsJson.command).toBe('metrics');
      expect(metricsJson.summary.commands.status).toBeDefined();

      metricsCollector.resetPersistent();
    });
  });
});
