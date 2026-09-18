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
function describeAIError(error: AIError, model: string): string {
  switch (error.kind) {
    case 'connection':
      return `💡 Make sure Ollama is running: ollama serve`;
    case 'model-not-found':
      return `💡 Install the model: ollama pull ${error.model || model}`;
    case 'empty-response':
      return `💡 Model returned nothing. Install it: ollama pull ${error.model || model}`;
    default:
      return error.cause;
  }
}

export async function runCommand(spec: CommandSpec): Promise<void> {
  const startTime = Date.now();
  const { name, input } = spec;
  const config = loadConfig();

  const fail = (error: string): void => {
    printError(error);
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

  const spinner = ora('Thinking...').start();
  try {
    spinner.stop();

    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold(spec.header));
    console.log();

    const response = await ask(spec.buildRequest(input, config.model));

    console.log('\n');
    if (spec.footer) {
      console.log(chalk.dim(spec.footer));
    }

    if (spec.onComplete) spec.onComplete(response, input);

    const duration = Date.now() - startTime;
    logCommand(name, startTime, true, { model: config.model });
    logPerformance(name, duration);
    metricsCollector.recordCommand(name, duration, true);
    logger.info(`${name} command completed successfully`, { duration });
  } catch (err) {
    spinner.stop();
    const duration = Date.now() - startTime;

    printError(`Command failed.`);
    console.log(chalk.yellow(describeAIError(err as AIError, config.model)));

    logError(`${name} command failed`, err as Error, { command: name });
    logCommand(name, startTime, false, { error: (err as Error).message });
    metricsCollector.recordCommand(name, duration, false);
    metricsCollector.recordError('ai_request_failed', name);
  }
}
