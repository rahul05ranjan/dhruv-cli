import { Ollama } from 'ollama';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printSuccess, printError, printInfo } from '../utils/ux.js';

export async function status() {
  console.log(chalk.blue('🔍 Dhruv CLI Status Check\n'));
  
  const config = loadConfig();
  printInfo(`Current configuration:`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Response Format: ${config.responseFormat}`);
  console.log(`  Verbose: ${config.verbose}`);
  console.log(`  Theme: ${config.theme}\n`);
  
  try {
    const ollama = new Ollama();
    
    // Test connection
    printInfo('Testing Ollama connection...');
    const models = await ollama.list();
    printSuccess('✓ Ollama is running and accessible');
    
    // List available models
    if (models.models && models.models.length > 0) {
      printSuccess(`✓ Found ${models.models.length} available models:`);
      models.models.forEach(model => {
        const isConfigured = model.name === config.model;
        const status = isConfigured ? chalk.green('(configured)') : '';
        console.log(`  • ${model.name} ${status}`);
      });
    } else {
      printError('✗ No models found');
      console.log(chalk.yellow('Install a model using: ollama pull llama2'));
    }
    
    // Test configured model
    if (models.models?.some(m => m.name === config.model)) {
      printSuccess(`✓ Configured model '${config.model}' is available`);
    } else {
      printError(`✗ Configured model '${config.model}' is not available`);
      const available = models.models?.map(m => m.name) || [];
      if (available.length > 0) {
        console.log(chalk.yellow(`Available models: ${available.join(', ')}`));
      }
    }
    
  } catch (error) {
    printError('✗ Ollama connection failed');
    console.log(chalk.red((error as Error).message));
    console.log(chalk.yellow('\nTo start Ollama, run: ollama serve'));
    console.log(chalk.yellow('To install a model, run: ollama pull llama2'));
  }
}
