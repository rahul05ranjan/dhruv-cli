import inquirer from 'inquirer';
import { themed } from '../utils/ux.js';
import { explain } from './explain.js';
import { suggest } from './suggest.js';
import { fix } from './fix.js';
import { review } from './review.js';
import { optimize } from './optimize.js';
import { securityCheck } from './security-check.js';
import { generate } from './generate.js';
import { init } from './init.js';
import { detectProjectType } from '../utils/projectType.js';
import chalk from 'chalk';

const commands = [
  { name: 'Explain', value: 'explain' },
  { name: 'Suggest', value: 'suggest' },
  { name: 'Fix', value: 'fix' },
  { name: 'Review', value: 'review' },
  { name: 'Optimize', value: 'optimize' },
  { name: 'Security Check', value: 'security-check' },
  { name: 'Generate', value: 'generate' },
  { name: 'Init (Setup)', value: 'init' },
  { name: 'Project Type', value: 'project-type' },
  { name: 'Exit', value: 'exit' }
];

export async function menu() {
  let running = true;
  while (running) {
    const { cmd } = await inquirer.prompt([
      {
        type: 'list',
        name: 'cmd',
        message: themed('What do you want to do?', 'primary'),
        choices: commands
      }
    ]);
    
    if (cmd === 'exit') {
      running = false;
      break;
    }

    try {
      switch (cmd) {
        case 'explain': {
          const { query } = await inquirer.prompt([
            { type: 'input', name: 'query', message: 'What would you like me to explain?' }
          ]);
          if (query) await explain(query);
          break;
        }
        case 'suggest': {
          const { query } = await inquirer.prompt([
            { type: 'input', name: 'query', message: 'What would you like suggestions for?' }
          ]);
          if (query) await suggest(query);
          break;
        }
        case 'fix': {
          const { query } = await inquirer.prompt([
            { type: 'input', name: 'query', message: 'Describe the issue you need help fixing:' }
          ]);
          if (query) await fix(query);
          break;
        }
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
        default:
          console.log(themed(`You selected: ${cmd}`, 'accent'));
      }
    } catch (error) {
      console.error(chalk.red(`Error executing ${cmd}: ${(error as Error).message}`));
    }

    console.log(''); // Add spacing between commands
  }
}
