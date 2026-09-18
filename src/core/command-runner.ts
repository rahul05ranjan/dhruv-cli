/**
 * The command runner: everything about executing an AI-backed command lives
 * here. Commands supply their specifics (prompt, file reading, footer text,
 * post-processing) and call the runner through one interface; the pipeline —
 * validation, rate limiting, spinner, header, AI call, streaming, logging,
 * metrics, error mapping — fires identically for every command.
 */
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printError } from '../utils/ux.js';
import { ask, AIError, AIRequest } from '../core/ai.js';
import { logger, logCommand, logPerformance, logError } from '../core/logger.js';
import { metricsCollector } from '../core/metrics.js';
import { securityManager } from '../core/security.js';

interface CommandResult {
  ok: boolean;
  command: string;
  model?: string;
  response?: string;
  error?: string;
  hint?: string;
  durationMs?: number;
}

/** What makes a command distinct. The runner owns everything else. */
export interface CommandSpec {
  /** Commander command name, for validation, logging, and metrics. */
  name: string;
  /** The user-facing arguments, validated as a unit. */
  input: Record<string, string>;
  /** Builds the AI request from validated input. */
  buildRequest: (input: Record<string, string>, model: string) => AIRequest;
  /** Header line under the banner, e.g. "📚 Explanation:". */
  header: string;
  /** Footer hint shown after success. */
  footer?: string;
  /** Post-processing on the full response (e.g. saving generated test files). */
  onComplete?: (response: string, input: Record<string, string>) => void;
}

/** Maps typed AI errors to user-facing hints — once, not per command. */
function describeAIError(error: unknown, model: string): string {
  if (!error || typeof error !== 'object' || !('kind' in error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const typedError = error as AIError;
  switch (typedError.kind) {
    case 'connection':
      return `💡 Make sure Ollama is running: ollama serve`;
    case 'model-not-found':
      return `💡 Install the model: ollama pull ${typedError.model || model}`;
    case 'empty-response':
      return `💡 Model returned nothing. Install it: ollama pull ${typedError.model || model}`;
    case 'timeout':
      return `💡 The request timed out after ${typedError.timeoutMs}ms. Try again, use a smaller prompt, or increase --timeout.`;
    case 'cancelled':
      return '💡 Request cancelled. Run the command again when ready.';
    default:
      return typedError.cause;
  }
}

export async function runCommand(spec: CommandSpec): Promise<void> {
  const startTime = Date.now();
  const { name, input } = spec;
  const config = loadConfig();
  const jsonOutput = config.responseFormat === 'json';

  const writeJson = (result: CommandResult): void => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  };

  const fail = (error: string): void => {
    process.exitCode = 2;
    if (jsonOutput) writeJson({ ok: false, command: name, error, model: config.model, durationMs: Date.now() - startTime });
    else printError(error);
    logCommand(name, startTime, false, { error });
    metricsCollector.recordCommand(name, Date.now() - startTime, false);
  };

  // Validation and rate limiting — every command, uniformly.
  const securityCheck = securityManager.validateInput(name, input);
  if (!securityCheck.valid) {
    fail(securityCheck.error!);
    return;
  }

  const rateLimitCheck = securityManager.checkRateLimit('user');
  if (!rateLimitCheck.allowed) {
    fail('Rate limit exceeded. Please try again later.');
    return;
  }

  const spinner = jsonOutput ? undefined : ora('Thinking...').start();
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  let sigintHandler: (() => void) | undefined;
  try {
    spinner?.stop();

    if (!jsonOutput) {
      console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
      console.log(chalk.green.bold(spec.header));
      console.log();
    }

    let streamed = false;
    const controller = new AbortController();
    const request = {
      ...spec.buildRequest(input, config.model),
      signal: controller.signal,
      onToken: (token: string) => {
        streamed = true;
        if (!jsonOutput) process.stdout.write(token);
      },
    };
    const aiStartTime = Date.now();
    const responsePromise = ask(request);
    const cancellationPromise = new Promise<string>((_, reject) => {
      sigintHandler = () => {
        controller.abort();
        reject({ kind: 'cancelled' } satisfies AIError);
      };
      process.once('SIGINT', sigintHandler);
    });
    const response = config.timeoutMs > 0
      ? await Promise.race([
        responsePromise,
        cancellationPromise,
        new Promise<string>((_, reject) => {
          requestTimeout = setTimeout(() => {
            controller.abort();
            reject({ kind: 'timeout', timeoutMs: config.timeoutMs } satisfies AIError);
          }, config.timeoutMs);
        }),
      ])
      : await Promise.race([responsePromise, cancellationPromise]);
    if (requestTimeout) clearTimeout(requestTimeout);
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    if (!response.trim()) {
      throw { kind: 'empty-response', model: config.model } satisfies AIError;
    }

    const durationMs = Date.now() - startTime;
    if (jsonOutput) {
      writeJson({ ok: true, command: name, model: config.model, response, durationMs });
    } else {
      if (!streamed) process.stdout.write(response);
      process.stdout.write('\n');
      console.log('\n');
      if (spec.footer) console.log(chalk.dim(spec.footer));
    }

    if (spec.onComplete) spec.onComplete(response, input);

    metricsCollector.recordAIRequest(config.model, name, Date.now() - aiStartTime, true);
    logCommand(name, startTime, true, { model: config.model });
    logPerformance(name, durationMs);
    metricsCollector.recordCommand(name, durationMs, true);
    logger.info(`${name} command completed successfully`, { duration: durationMs });
  } catch (err) {
    spinner?.stop();
    if (requestTimeout) clearTimeout(requestTimeout);
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    const cancelled = typeof err === 'object' && err !== null && 'kind' in err && (err as { kind?: string }).kind === 'cancelled';
    process.exitCode = cancelled ? 130 : 1;
    const duration = Date.now() - startTime;
    const hint = describeAIError(err as AIError, config.model);
    metricsCollector.recordAIRequest(config.model, name, duration, false);

    if (jsonOutput) {
      writeJson({ ok: false, command: name, model: config.model, error: 'Command failed.', hint, durationMs: duration });
    } else {
      printError(`Command failed.`);
      console.log(chalk.yellow(hint));
    }

    logError(`${name} command failed`, err as Error, { command: name });
    logCommand(name, startTime, false, { error: (err as Error).message });
    metricsCollector.recordCommand(name, duration, false);
    metricsCollector.recordError('ai_request_failed', name);
  }
}
