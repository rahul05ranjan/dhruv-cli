import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { takeRuntimeDiagnosticSnapshot } from '../src/core/runtime-diagnostic';
import { listModels, getOllamaStatus } from '../src/core/ai';
import { saveConfig } from '../src/config/config';

jest.mock('../src/core/ai', () => ({
  listModels: jest.fn(),
  getOllamaStatus: jest.fn(),
}));

describe('Runtime Diagnostic Snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('captures a ready snapshot when configured model is available locally', async () => {
    jest.mocked(listModels).mockResolvedValue(['llama3', 'mistral']);
    jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.1.28' });
    saveConfig({ model: 'llama3' });

    const snapshot = await takeRuntimeDiagnosticSnapshot();

    expect(snapshot).toEqual({
      configuredModel: 'llama3',
      availableModels: ['llama3', 'mistral'],
      endpoint: 'http://127.0.0.1:11434',
      version: '0.1.28',
      ollama: 'connected',
      configuredModelAvailable: true,
      ready: true,
      error: undefined,
      nextSteps: [],
    });
  });

  it('captures an unready snapshot with nextSteps when configured model is missing', async () => {
    jest.mocked(listModels).mockResolvedValue(['mistral']);
    jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', version: '0.1.28' });
    saveConfig({ model: 'llama3' });

    const snapshot = await takeRuntimeDiagnosticSnapshot();

    expect(snapshot.configuredModel).toBe('llama3');
    expect(snapshot.availableModels).toEqual(['mistral']);
    expect(snapshot.configuredModelAvailable).toBe(false);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.ollama).toBe('connected');
    expect(snapshot.nextSteps).toEqual(['ollama pull llama3']);
  });

  it('captures an unavailable snapshot when Ollama cannot be reached', async () => {
    jest.mocked(listModels).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    jest.mocked(getOllamaStatus).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434' });
    saveConfig({ model: 'llama3' });

    const snapshot = await takeRuntimeDiagnosticSnapshot();

    expect(snapshot.configuredModel).toBe('llama3');
    expect(snapshot.availableModels).toEqual([]);
    expect(snapshot.configuredModelAvailable).toBe(false);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.ollama).toBe('unavailable');
    expect(snapshot.error).toBe('connect ECONNREFUSED 127.0.0.1:11434');
    expect(snapshot.nextSteps).toEqual(['ollama serve', 'ollama pull llama3']);
  });
});
