import { loadConfig } from '../config/config.js';
import { listModels, getOllamaStatus } from './ai.js';

export interface RuntimeDiagnosticSnapshot {
  configuredModel: string;
  availableModels: string[];
  endpoint: string;
  version: string | null;
  ollama: 'connected' | 'unavailable';
  configuredModelAvailable: boolean;
  ready: boolean;
  error?: string;
  nextSteps: string[];
}

export interface RuntimeDiagnosticOptions {
  model?: string;
}

export async function takeRuntimeDiagnosticSnapshot(
  options: RuntimeDiagnosticOptions = {}
): Promise<RuntimeDiagnosticSnapshot> {
  const config = loadConfig();
  const configuredModel = options.model ?? config.model;
  const server = await getOllamaStatus();
  const endpoint = server.endpoint;
  const version = server.version ?? null;

  try {
    const availableModels = await listModels();
    const configuredModelAvailable = availableModels.includes(configuredModel);
    const ready = configuredModelAvailable;
    const nextSteps = configuredModelAvailable ? [] : [`ollama pull ${configuredModel}`];

    return {
      configuredModel,
      availableModels,
      endpoint,
      version,
      ollama: 'connected',
      configuredModelAvailable,
      ready,
      nextSteps,
    };
  } catch (err) {
    const error = (err as Error).message;
    return {
      configuredModel,
      availableModels: [],
      endpoint,
      version,
      ollama: 'unavailable',
      configuredModelAvailable: false,
      ready: false,
      error,
      nextSteps: ['ollama serve', `ollama pull ${configuredModel}`],
    };
  }
}
