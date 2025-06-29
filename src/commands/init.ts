import inquirer from 'inquirer';
import { saveConfig, loadConfig } from '../config/config.js';
import chalk from 'chalk';

export async function init() {
  const current = loadConfig();
  let modelChoices = [current.model];
  try {
    // Dynamically import node-fetch for compatibility
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetch: any = (await import('node-fetch')).default;
    // Fetch models from Ollama REST API
    const res = await fetch('http://localhost:11434/api/tags');
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      if (Array.isArray(data.models) && data.models.length > 0) {
        modelChoices = data.models.map((m) => m.name);
      }
    }
  } catch {
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
