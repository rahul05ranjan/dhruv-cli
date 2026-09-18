import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printSuccess, printError, printInfo } from '../utils/ux.js';
import { listModels } from '../core/ai.js';

export async function status() {
  console.log(chalk.blue('🔍 Dhruv CLI Status Check\n'));

  const config = loadConfig();
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
      printError(`✗ Configured model '${config.model}' is not available`);
      if (models.length > 0) {
        console.log(chalk.yellow(`Available models: ${models.join(', ')}`));
      }
    }
  } catch (error) {
    printError('✗ Ollama connection failed');
    console.log(chalk.red((error as Error).message));
    console.log(chalk.yellow('\nTo start Ollama, run: ollama serve'));
    console.log(chalk.yellow('To install a model, run: ollama pull llama2'));
  }
}
