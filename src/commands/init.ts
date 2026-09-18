import inquirer from 'inquirer';
import { saveConfig, loadConfig } from '../config/config.js';
import chalk from 'chalk';
import { listModels } from '../core/ai.js';

export async function init() {
  const current = loadConfig();
  let modelChoices = [current.model];

  try {
    const models = await listModels();
    if (models.length > 0) {
      modelChoices = models;
    }
  } catch {
    console.log(chalk.yellow('Warning: Could not connect to Ollama.'));
    console.log(chalk.yellow('💡 Start Ollama with: ollama serve'));
    console.log(chalk.yellow(`💡 Install default model with: ollama pull ${current.model}\n`));
  }

  try {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: `Which Ollama model do you want to use? (default: ${current.model})`,
        choices: modelChoices,
        default: current.model,
      },
      {
        type: 'list',
        name: 'scope',
        message: 'Where should Dhruv save these settings?',
        choices: ['local', 'global'],
        default: 'local',
      },
      {
        type: 'list',
        name: 'responseFormat',
        message: 'Preferred response format?',
        choices: ['text', 'json', 'markdown'],
        default: current.responseFormat,
      },
      {
        type: 'confirm',
        name: 'verbose',
        message: 'Enable verbose output?',
        default: current.verbose,
      },
      {
        type: 'list',
        name: 'theme',
        message: 'Choose a color theme:',
        choices: ['default', 'dark', 'light', 'mono'],
        default: current.theme || 'default',
      },
    ]);

    const { scope, ...settings } = answers;
    saveConfig(settings, { scope });
    console.log(chalk.green(`Configuration saved ${scope === 'global' ? 'for your user account' : 'in this project'}!`));
  } catch (error) {
    const isTty = Boolean((error as { isTtyError?: boolean })?.isTtyError);
    process.exitCode = isTty ? 1 : 130;
    if (isTty) {
      console.log(chalk.red('This command requires an interactive terminal.'));
    } else {
      console.log(chalk.red('Configuration cancelled.'));
    }
  }
}
