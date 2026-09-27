import { printError, printInfo } from '../utils/ux.js';
import {
  ingestSource,
  type SourceBundle,
  type LoadSourceOptions,
} from './source-ingestion.js';

export * from './source-ingestion.js';

/**
 * Temporary compatibility path for commands that have not yet migrated
 * to fact-only Source Ingestion outcomes.
 */
export function loadSource(target: string, options: LoadSourceOptions = {}): SourceBundle | null {
  const outcome = ingestSource(target, options);
  if (!outcome.ok) {
    printError(outcome.message);
    process.exitCode = 1;
    return null;
  }

  if (outcome.capped) {
    printInfo(`Note: Directory review is capped at the first ${options.maxFiles ?? 10} source files.`);
  }

  return outcome;
}
