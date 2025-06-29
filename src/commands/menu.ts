import inquirer from 'inquirer';
import chalk from 'chalk';
import { themed } from '../utils/ux.js';

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
  while (true) {
    const { cmd } = await inquirer.prompt([
      {
        type: 'list',
        name: 'cmd',
        message: themed('What do you want to do?', 'primary'),
        choices: commands
      }
    ]);
    if (cmd === 'exit') break;
    // For demo, just print the command. In real use, you would call the command handler.
    console.log(themed(`You selected: ${cmd}`, 'accent'));
  }
}
