import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printSuccess, printError, printInfo } from '../utils/ux.js';
import { takeRuntimeDiagnosticSnapshot } from '../core/runtime-diagnostic.js';

export async function status() {
  const config = loadConfig();
  const snapshot = await takeRuntimeDiagnosticSnapshot();

  if (config.responseFormat === 'json') {
    if (snapshot.ollama === 'unavailable') {
      process.exitCode = 1;
      process.stdout.write(`${JSON.stringify({
        ok: false,
        command: 'status',
        model: snapshot.configuredModel,
        ollama: 'unavailable',
        error: snapshot.error,
      })}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify({
      ok: snapshot.configuredModelAvailable,
      command: 'status',
      model: snapshot.configuredModel,
      responseFormat: config.responseFormat,
      verbose: config.verbose,
      theme: config.theme,
      availableModels: snapshot.availableModels,
      configuredModelAvailable: snapshot.configuredModelAvailable,
      endpoint: snapshot.endpoint,
      version: snapshot.version,
      ollama: snapshot.ollama,
      nextSteps: snapshot.nextSteps,
    })}\n`);
    if (!snapshot.configuredModelAvailable) process.exitCode = 1;
    return;
  }

  console.log(chalk.blue('🔍 Dhruv CLI Status Check\n'));
  printInfo(`Ollama endpoint: ${snapshot.endpoint}`);
  printInfo(`Ollama version: ${snapshot.version ?? 'unavailable'}\n`);
  printInfo(`Current configuration:`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Response Format: ${config.responseFormat}`);
  console.log(`  Verbose: ${config.verbose}`);
  console.log(`  Theme: ${config.theme}\n`);

  if (snapshot.ollama === 'unavailable') {
    process.exitCode = 1;
    printError('✗ Ollama connection failed');
    console.log(chalk.red(snapshot.error ?? 'Connection failed'));
    console.log(chalk.yellow('\n💡 To start Ollama, run: ollama serve'));
    console.log(chalk.yellow(`💡 To install the configured model, run: ollama pull ${snapshot.configuredModel}`));
    return;
  }

  printInfo('Testing Ollama connection...');
  printSuccess('✓ Ollama is running and accessible');

  if (snapshot.availableModels.length > 0) {
    printSuccess(`✓ Found ${snapshot.availableModels.length} available models:`);
    snapshot.availableModels.forEach((name) => {
      const isConfigured = name === snapshot.configuredModel;
      const itemStatus = isConfigured ? chalk.green('(configured)') : '';
      console.log(`  • ${name} ${itemStatus}`);
    });
  } else {
    printError('✗ No models found');
    console.log(chalk.yellow('Install a model using: ollama pull llama2'));
  }

  if (snapshot.configuredModelAvailable) {
    printSuccess(`✓ Configured model '${snapshot.configuredModel}' is available`);
  } else {
    process.exitCode = 1;
    printError(`✗ Configured model '${snapshot.configuredModel}' is not available`);
    console.log(chalk.yellow(`💡 Install the model: ollama pull ${snapshot.configuredModel}`));
    if (snapshot.availableModels.length > 0) {
      console.log(chalk.yellow(`Available models: ${snapshot.availableModels.join(', ')}`));
    }
  }
}
