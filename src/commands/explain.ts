import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printError } from '../utils/ux.js';
import { logger, logCommand, logPerformance, logError } from '../core/logger.js';
import { metricsCollector } from '../core/metrics.js';
import { securityManager } from '../core/security.js';

export async function explain(query: string) {
  const startTime = Date.now();
  const command = 'explain';

  try {
    // Security validation
    const securityCheck = securityManager.validateInput(command, { query });
    if (!securityCheck.valid) {
      printError(securityCheck.error!);
      logCommand(command, startTime, false, { error: securityCheck.error });
      metricsCollector.recordCommand(command, Date.now() - startTime, false);
      return;
    }

    // Rate limiting check
    const rateLimitCheck = securityManager.checkRateLimit('user');
    if (!rateLimitCheck.allowed) {
      printError('Rate limit exceeded. Please try again later.');
      logCommand(command, startTime, false, { error: 'rate_limit_exceeded' });
      metricsCollector.recordCommand(command, Date.now() - startTime, false);
      return;
    }

    if (!query || query.trim().length === 0) {
      printError('Please provide a query to explain.');
      console.log(chalk.yellow('Example: dhruv explain "What is async/await in JavaScript?"'));
      logCommand(command, startTime, false, { error: 'empty_query' });
      metricsCollector.recordCommand(command, Date.now() - startTime, false);
      return;
    }

    const config = loadConfig();
    const spinner = ora('Thinking...').start();

    logger.info('Starting explain command', {
      query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
      model: config.model
    });

    try {
      spinner.stop();

      console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
      console.log(chalk.green.bold('📚 Explanation: '));
      console.log();

      const _response = await askLangChain({
        prompt: query,
        systemMessage: getSystemMessage('explain'),
        model: config.model,
        onToken: (token: string) => {
          process.stdout.write(chalk.cyan(token));
        }
      });

      console.log('\n');
      console.log(chalk.dim('💡 Need more help? Try: ') +
                  chalk.cyan('dhruv suggest "') + chalk.white(query) + chalk.cyan('"'));

      const duration = Date.now() - startTime;
      logCommand(command, startTime, true, {
        queryLength: query.length,
        responseLength: _response.length,
        model: config.model
      });
      logPerformance('explain_command', duration);
      metricsCollector.recordCommand(command, duration, true);

      logger.info('Explain command completed successfully', {
        duration,
        queryLength: query.length,
        responseLength: _response.length
      });

    } catch (aiError) {
      spinner.stop();
      const duration = Date.now() - startTime;
      const errorMessage = (aiError as Error).message;

      printError('Failed to get explanation.');

      if (errorMessage.includes('Ollama is not running')) {
        console.log(chalk.yellow('💡 Make sure Ollama is running: ') + chalk.cyan('ollama serve'));
      } else if (errorMessage.includes('not found')) {
        console.log(chalk.yellow('💡 Install the model: ') + chalk.cyan(`ollama pull ${config.model}`));
      } else {
        console.error(chalk.red(errorMessage));
      }

      logError('Explain command failed', aiError as Error, {
        command,
        query: query.substring(0, 100),
        model: config.model
      });
      logCommand(command, startTime, false, { error: errorMessage });
      metricsCollector.recordCommand(command, duration, false);
      metricsCollector.recordError('ai_request_failed', command);
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = (error as Error).message;

    printError('Unexpected error occurred');
    console.error(chalk.red(errorMessage));

    logError('Explain command unexpected error', error as Error, { command });
    logCommand(command, startTime, false, { error: errorMessage, type: 'unexpected' });
    metricsCollector.recordCommand(command, duration, false);
    metricsCollector.recordError('unexpected_error', command);
  }
}
