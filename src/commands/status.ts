import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printSuccess, printError, printInfo } from '../utils/ux.js';
import { getOllamaStatus, listModels } from '../core/ai.js';

export async function status() {
  const config = loadConfig();
  if (config.responseFormat === 'json') {
    try {
      const models = await listModels();
      const server = await getOllamaStatus();
      const configuredModelAvailable = models.includes(config.model);
      process.stdout.write(`${JSON.stringify({
        ok: configuredModelAvailable,
        command: 'status',
        model: config.model,
        responseFormat: config.responseFormat,
        verbose: config.verbose,
        theme: config.theme,
        availableModels: models,
        configuredModelAvailable,
        endpoint: server.endpoint,
        version: server.version ?? null,
        ollama: 'connected',
        nextSteps: configuredModelAvailable ? [] : [`ollama pull ${config.model}`],
      })}\n`);
      if (!configuredModelAvailable) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      process.stdout.write(`${JSON.stringify({
        ok: false,
        command: 'status',
        model: config.model,
        ollama: 'unavailable',
        error: (error as Error).message,
      })}\n`);
    }
    return;
  }

  console.log(chalk.blue('🔍 Dhruv CLI Status Check\n'));
  const server = await getOllamaStatus();
  printInfo(`Ollama endpoint: ${server.endpoint}`);
  printInfo(`Ollama version: ${server.version ?? 'unavailable'}\n`);
  printInfo(`Current configuration:`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Response Format: ${config.responseFormat}`);
  console.log(`  Verbose: ${config.verbose}`);
  console.log(`  Theme: ${config.theme}\n`);

  try {
    printInfo('Testing Ollama connection...');
    const models = await listModels();
    printSuccess('✓ Ollama is running and accessible');

    if (models.length > 0) {
      printSuccess(`✓ Found ${models.length} available models:`);
      models.forEach((name) => {
        const isConfigured = name === config.model;
        const status = isConfigured ? chalk.green('(configured)') : '';
        console.log(`  • ${name} ${status}`);
      });
    } else {
      printError('✗ No models found');
      console.log(chalk.yellow('Install a model using: ollama pull llama2'));
    }

    if (models.includes(config.model)) {
      printSuccess(`✓ Configured model '${config.model}' is available`);
    } else {
      process.exitCode = 1;
      printError(`✗ Configured model '${config.model}' is not available`);
      console.log(chalk.yellow(`💡 Install the model: ollama pull ${config.model}`));
      if (models.length > 0) {
        console.log(chalk.yellow(`Available models: ${models.join(', ')}`));
      }
    }
  } catch (error) {
    process.exitCode = 1;
    printError('✗ Ollama connection failed');
    console.log(chalk.red((error as Error).message));
    console.log(chalk.yellow('\n💡 To start Ollama, run: ollama serve'));
    console.log(chalk.yellow(`💡 To install the configured model, run: ollama pull ${config.model}`));
  }
}
