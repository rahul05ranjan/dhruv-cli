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
    console.log(chalk.yellow('Warning: Could not fetch available models from Ollama.'));
    console.log(chalk.yellow('Using default model choices.'));
  }

  try {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Which Ollama model do you want to use?',
        choices: modelChoices,
        default: current.model,
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

    saveConfig(answers);
    console.log(chalk.green('Configuration saved!'));
  } catch (error) {
    if ((error as { isTtyError?: boolean })?.isTtyError) {
      console.log(chalk.red('This command requires an interactive terminal.'));
    } else {
      console.log(chalk.red('Configuration cancelled or failed.'));
    }
  }
}
