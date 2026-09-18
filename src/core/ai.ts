/**
 * The AI module: everything about talking to a local model lives here.
 *
 * Interface (the only surface callers and tests cross):
 *   ask(request)        -> full response, optionally streaming tokens via onToken
 *   listModels()        -> available model names
 *
 * Everything else — connection handling, streaming, caching, error
 * translation — is implementation. Two adapters satisfy the interface:
 * the HTTP adapter (production, talks to the local Ollama server) and the
 * in-memory adapter (tests). No third adapter exists.
 */
import { Ollama } from 'ollama';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig } from '../config/config.js';

/** Typed errors: the runner maps these to user-facing hints, never by string matching. */
export type AIError =
  | { kind: 'connection'; cause: string }
  | { kind: 'model-not-found'; model: string }
  | { kind: 'empty-response'; model: string }
  | { kind: 'request'; cause: string };

export interface AIRequest {
  prompt: string;
  systemMessage?: string;
  context?: string;
  model?: string;
  onToken?: (token: string) => void;
}

/** The seam. Both adapters implement this; commands and tests depend on it, never on Ollama. */
export interface AIClient {
  ask(request: AIRequest): Promise<string>;
  listModels(): Promise<string[]>;
}

const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_FILES = 100;

function cacheDir(): string {
  return path.join(process.cwd(), '.dhruv-cache');
}

function cacheKey(request: AIRequest, model: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${model}:${request.systemMessage ?? ''}:${request.context ?? ''}:${request.prompt}`)
    .digest('hex');
  return path.join(cacheDir(), hash);
}

function readCache(request: AIRequest, model: string): string | undefined {
  const file = cacheKey(request, model);
  try {
    if (!fs.existsSync(file)) return undefined;
    const stats = fs.statSync(file);
    if (Date.now() - stats.mtimeMs > CACHE_EXPIRY_MS) {
      fs.unlinkSync(file);
      return undefined;
    }
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

function writeCache(request: AIRequest, model: string, response: string): void {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheKey(request, model), response);
  } catch {
    // Cache write failures never fail the request.
  }
}

/** Wired up (the old cleanupCache was never called); runs opportunistically after a cache write. */
function cleanupCache(): void {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) return;
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .filter((entry) => {
        if (Date.now() - entry.mtimeMs > CACHE_EXPIRY_MS) {
          fs.unlinkSync(entry.file);
          return false;
        }
        return true;
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = entries.length - MAX_CACHE_FILES;
    if (excess > 0) {
      for (const entry of entries.slice(0, excess)) fs.unlinkSync(entry.file);
    }
  } catch {
    // Ignore cleanup errors.
  }
}

function toAIError(err: unknown, model: string): AIError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('ENOTFOUND')) {
    return { kind: 'connection', cause: message };
  }
  if (message.includes('not found')) {
    return { kind: 'model-not-found', model };
  }
  return { kind: 'request', cause: message };
}

/**
 * HTTP adapter: production. Standardizes on the Ollama client package —
 * the raw-HTTP path existed only to work around a LangChain prompt-template
 * issue, and that integration is gone.
 */
export class OllamaAIClient implements AIClient {
  private client: Ollama;

  constructor(client?: Ollama) {
    this.client = client ?? new Ollama();
  }

  async ask(request: AIRequest): Promise<string> {
    const model = request.model ?? loadConfig().model;
    const fullPrompt = request.systemMessage
      ? `System: ${request.systemMessage}\n\n${request.context ? `Context: ${request.context}\n\n` : ''}Query: ${request.prompt}`
      : request.prompt;

    const cached = readCache(request, model);
    if (cached !== undefined) {
      if (request.onToken) request.onToken(cached);
      return cached;
    }

    try {
      const streaming = Boolean(request.onToken);
      let result = '';

      if (streaming) {
        const stream = await this.client.generate({ model, prompt: fullPrompt, stream: true });
        for await (const chunk of stream) {
          const token = typeof chunk === 'object' && chunk !== null && 'response' in chunk ? chunk.response : '';
          if (!token) continue;
          result += token;
          if (request.onToken) request.onToken(token);
        }
      } else {
        const response = await this.client.generate({ model, prompt: fullPrompt, stream: false });
        result = response.response ?? '';
      }

      if (!result.trim()) {
        throw new Error(`Model '${model}' not found or returned empty response`);
      }

      writeCache(request, model, result.trim());
      cleanupCache();
      return result.trim();
    } catch (err) {
      throw toAIError(err, model);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.list();
      return (models.models ?? []).map((m) => m.name);
    } catch (err) {
      throw toAIError(err, 'unknown');
    }
  }
}

/**
 * In-memory adapter: tests. Satisfies the same interface with no network,
 * which is what makes AI behavior testable without Ollama installed.
 */
export class InMemoryAIClient implements AIClient {
  private store = new Map<string, { response: string; createdAt: number }>();
  /** Failures to simulate, keyed by prompt substring. */
  failures = new Map<string, AIError>();
  /** Count of computations performed (not cache reads) — lets tests observe cache hits. */
  computations = 0;
  /** Simulated clock for expiry tests. */
  now = () => Date.now();
  /** TTL override for tests; defaults to the production expiry. */
  ttlMs: number = CACHE_EXPIRY_MS;

  constructor(private responses: Map<string, string> = new Map()) {}

  async ask(request: AIRequest): Promise<string> {
    const model = request.model ?? 'test-model';
    for (const [substring, failure] of this.failures) {
      if (request.prompt.includes(substring)) throw failure;
    }

    const key = `${model}:${request.systemMessage ?? ''}:${request.context ?? ''}:${request.prompt}`;
    const hit = this.store.get(key);
    if (hit && this.now() - hit.createdAt <= this.ttlMs) {
      if (request.onToken) request.onToken(hit.response);
      return hit.response;
    }

    this.computations += 1;
    const response = this.responses.get(request.prompt) ?? `response:${request.prompt}`;
    this.store.set(key, { response, createdAt: this.now() });
    if (request.onToken) request.onToken(response);
    return response;
  }

  async listModels(): Promise<string[]> {
    return ['test-model', 'other-model'];
  }
}

/** Default client: the HTTP adapter. Tests inject InMemoryAIClient instead. */
let defaultClient: AIClient | undefined;

export function getAIClient(): AIClient {
  if (!defaultClient) defaultClient = new OllamaAIClient();
  return defaultClient;
}

/** Test seam setter: swaps the adapter the module hands out. */
export function setAIClient(client: AIClient): void {
  defaultClient = client;
}

/**
 * The interface commands call. Kept as module functions so callers don't
 * reach for a client object; the client is resolved internally.
 */
export async function ask(request: AIRequest): Promise<string> {
  return getAIClient().ask(request);
}

export async function listModels(): Promise<string[]> {
  return getAIClient().listModels();
}

/** Default model, from configuration — one source of truth. */
export function defaultModel(): string {
  return loadConfig().model;
}
