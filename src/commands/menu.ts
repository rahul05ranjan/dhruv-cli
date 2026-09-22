import inquirer from 'inquirer';
import { themed } from '../utils/ux.js';
import { review } from './review.js';
import { optimize } from './optimize.js';
import { securityCheck } from './security-check.js';
import { generate } from './generate.js';
import { init } from './init.js';
import { status } from './status.js';
import { health } from './health.js';
import { metrics } from './metrics.js';
import { detectProjectType } from '../utils/projectType.js';
import chalk from 'chalk';
import { commandCatalog, queryCommandDefinitions } from '../core/command-catalog.js';

const commands = [
  ...commandCatalog.map(({ menuLabel, name }) => ({ name: menuLabel, value: name })),
  { name: 'Exit', value: 'exit' },
];

export async function menu() {
  try {
    while (true) {
      const { filter = '' } = await inquirer.prompt([
        {
          type: 'input',
          name: 'filter',
          message: 'Filter commands (press enter to show all):',
        },
      ]);
      const normalizedFilter = String(filter).trim().toLowerCase();
      const filteredCommands = normalizedFilter
        ? commands.filter((command) => command.name.toLowerCase().includes(normalizedFilter) || command.value.includes(normalizedFilter))
        : commands;
      const { cmd } = await inquirer.prompt([
        {
          type: 'list',
          name: 'cmd',
          message: themed('What do you want to do?', 'primary'),
          choices: filteredCommands.length > 0 ? filteredCommands : [{ name: 'No matching commands — Exit', value: 'exit' }],
        }
      ]);
    
      if (cmd === 'exit') {
        break;
      }

      try {
        const queryCommand = queryCommandDefinitions.find((definition) => definition.name === cmd);
        if (queryCommand) {
          const { query } = await inquirer.prompt([
            { type: 'input', name: 'query', message: queryCommand.menuPrompt }
          ]);
          if (query) await queryCommand.action(query);
        } else {
          switch (cmd) {
            case 'review': {
              const { fileOrDir } = await inquirer.prompt([
                { type: 'input', name: 'fileOrDir', message: 'Enter file or directory path to review:' }
              ]);
              if (fileOrDir) await review(fileOrDir);
              break;
            }
            case 'optimize': {
              const { file } = await inquirer.prompt([
                { type: 'input', name: 'file', message: 'Enter file path to optimize:' }
              ]);
              if (file) await optimize(file);
              break;
            }
            case 'security-check': {
              const { fileOrDir } = await inquirer.prompt([
                { type: 'input', name: 'fileOrDir', message: 'Enter file or directory path to check (or press enter for current directory):', default: '.' }
              ]);
              await securityCheck(fileOrDir);
              break;
            }
            case 'generate': {
              const answers = await inquirer.prompt([
                {
                  type: 'list',
                  name: 'type',
                  message: 'What would you like to generate?',
                  choices: ['tests', 'documentation', 'docs', 'component']
                },
                { type: 'input', name: 'target', message: 'Enter target file path:' }
              ]);
              if (answers.target) await generate(answers.type, answers.target);
              break;
            }
            case 'init': {
              await init();
              break;
            }
            case 'project-type': {
              const type = detectProjectType();
              console.log(chalk.blue(`Detected project type: ${type}`));
              break;
            }
            case 'status':
              await status();
              break;
            case 'health':
              await health();
              break;
            case 'metrics':
              await metrics();
              break;
            case 'completion':
              console.log(themed('Run `dhruv completion <bash|zsh|fish>` to install shell completion.', 'accent'));
              break;
            default:
              console.log(themed(`You selected: ${cmd}`, 'accent'));
          }
        }
      } catch (error) {
        console.error(chalk.red(`Error executing ${cmd}: ${(error as Error).message}`));
      }

      console.log(''); // Add spacing between commands
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancel|force closed|exitprompt/i.test(message);
    process.exitCode = cancelled ? 130 : 1;
    console.error(chalk.red(cancelled ? 'Interactive menu cancelled.' : `Interactive menu failed: ${message}`));
  }
}
