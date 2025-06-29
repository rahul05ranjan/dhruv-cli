import inquirer from 'inquirer';
import { saveConfig, loadConfig } from '../config/config.js';
import chalk from 'chalk';
import { Ollama } from 'ollama';

export async function init() {
  const current = loadConfig();
  let modelChoices = [current.model];
  try {
    const ollama = new Ollama();
    const tags = await ollama.tags();
    if (Array.isArray(tags) && tags.length > 0) {
      modelChoices = tags.map(t => t.name);
    }
  } catch (e) {
    // If Ollama is not running or fails, fallback to current model
  }
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
}
