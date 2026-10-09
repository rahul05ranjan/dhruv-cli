import { setSessionConfig, type DhruvConfig } from '../config/config.js';
import type { BuiltInOption } from './built-in-commands.js';

/** Program-level options shared by every command. */
export const globalOptions: readonly BuiltInOption[] = [
  { flags: '--model <model>', description: 'Set Ollama model' },
  { flags: '--verbose', description: 'Enable verbose output' },
  { flags: '--json', description: 'Output in JSON format' },
  { flags: '--timeout <milliseconds>', description: 'Set the AI request timeout' },
];

/** Applies the program-level options to the in-memory session configuration. */
export function applyGlobalOptions(opts: Record<string, unknown>): void {
  if (!(opts.model || opts.verbose || opts.json || opts.timeout)) return;
  const config: Partial<DhruvConfig> = {};
  if (opts.model) config.model = String(opts.model);
  if (opts.verbose) config.verbose = true;
  if (opts.json) config.responseFormat = 'json';
  if (opts.timeout) config.timeoutMs = Number(opts.timeout);
  setSessionConfig(config);
}
