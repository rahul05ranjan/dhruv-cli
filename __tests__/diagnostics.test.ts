import { describe, expect, it, jest } from '@jest/globals';
import { saveConfig } from '../src/config/config';
import { status } from '../src/commands/status';
import { health } from '../src/commands/health';
import { metrics } from '../src/commands/metrics';
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

describe('diagnostic commands', () => {
  it('emits structured status output in JSON mode', async () => {
    jest.mocked(listModels).mockResolvedValue(['test-model']);
    jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.12.3' });
    saveConfig({ model: 'test-model', responseFormat: 'json' });
    const output: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await status();
      expect(JSON.parse(output.join(''))).toMatchObject({
        ok: true,
        command: 'status',
        model: 'test-model',
        availableModels: ['test-model'],
        endpoint: 'http://127.0.0.1:11434',
        version: '0.12.3',
      });
    } finally {
      write.mockRestore();
      saveConfig({ responseFormat: 'text' });
    }
  });

  it('emits structured health output in JSON mode', async () => {
    jest.mocked(listModels).mockResolvedValue(['test-model']);
    saveConfig({ model: 'test-model', responseFormat: 'json' });
    const output: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await health();
      const result = JSON.parse(output.join('')) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, command: 'health' });
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('summary');
    } finally {
      write.mockRestore();
      saveConfig({ responseFormat: 'text' });
    }
  });

  it('retains a local command summary across collector reads', () => {
    metricsCollector.resetPersistent();
    metricsCollector.recordCommand('explain', 1250, true);

    expect(metricsCollector.getSummary()).toMatchObject({
      commands: {
        explain: {
          runs: 1,
          successes: 1,
          failures: 0,
          durationMs: 1250,
        },
      },
    });

    metricsCollector.resetPersistent();
  });

  it('retains model and cache activity in the local summary', () => {
    metricsCollector.resetPersistent();
    metricsCollector.recordAIRequest('test-model', 'explain', 250, true);
    metricsCollector.recordCacheHit('ai-response');
    metricsCollector.recordCacheMiss('ai-response');

    expect(metricsCollector.getSummary()).toMatchObject({
      models: {
        'test-model': { requests: 1, successes: 1, failures: 0, durationMs: 250 },
      },
      cache: { hits: 1, misses: 1 },
    });

    metricsCollector.resetPersistent();
  });

  it('emits persisted metrics in JSON mode', async () => {
    metricsCollector.resetPersistent();
    metricsCollector.recordCommand('status', 50, true);
    saveConfig({ responseFormat: 'json' });
    const output: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await metrics();
      expect(JSON.parse(output.join(''))).toMatchObject({
        ok: true,
        command: 'metrics',
        summary: { commands: { status: { runs: 1 } } },
      });
    } finally {
      write.mockRestore();
      saveConfig({ responseFormat: 'text' });
      metricsCollector.resetPersistent();
    }
  });
});
