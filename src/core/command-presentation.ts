import { printError, printInfo } from '../utils/ux.js';
import { loadConfig } from '../config/config.js';
import type { SourceOutcome, SourceSuccessOutcome, SourceFailureOutcome } from './source-ingestion.js';

export interface CommandPresentationAdapter {
  presentSourceFailure(command: string, failure: SourceFailureOutcome): void;
  presentSourceNotice?(command: string, message: string): void;
}

export class TextPresentationAdapter implements CommandPresentationAdapter {
  presentSourceFailure(_command: string, failure: SourceFailureOutcome): void {
    process.exitCode = 1;
    printError(failure.message);
  }

  presentSourceNotice(_command: string, message: string): void {
    printInfo(message);
  }
}

export class JsonPresentationAdapter implements CommandPresentationAdapter {
  presentSourceFailure(command: string, failure: SourceFailureOutcome): void {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      command,
      error: failure.message,
    })}\n`);
  }

  presentSourceNotice(_command: string, _message: string): void {
    // Structured JSON suppresses incidental terminal notices
  }
}

export function getPresentationAdapter(format?: string): CommandPresentationAdapter {
  const responseFormat = format ?? loadConfig().responseFormat;
  return responseFormat === 'json' ? new JsonPresentationAdapter() : new TextPresentationAdapter();
}

export function presentSourceOutcome(
  command: string,
  outcome: SourceOutcome,
  adapter: CommandPresentationAdapter = getPresentationAdapter()
): outcome is SourceSuccessOutcome {
  if (!outcome.ok) {
    adapter.presentSourceFailure(command, outcome);
    return false;
  }
  if (outcome.capped && adapter.presentSourceNotice) {
    adapter.presentSourceNotice(
      command,
      `Note: Directory ${command} is capped at the first ${outcome.maxFiles ?? 10} source files.`
    );
  }
  return true;
}
