import inquirer from 'inquirer';
import { themed } from '../utils/ux.js';
import chalk from 'chalk';
import { builtInCommands, findBuiltInCommand, type BuiltInCommand } from './built-in-commands.js';

// Built lazily: definitions import command modules that may import this menu.
function menuChoices() {
  return [
    ...builtInCommands.map(({ menuLabel, name }) => ({ name: menuLabel, value: name })),
    { name: 'Exit', value: 'exit' },
  ];
}

/** Menu adapter: asks for each argument with a menu prompt, then runs the definition with default options. */
async function runFromMenu(definition: BuiltInCommand): Promise<void> {
  if (definition.menuHint) {
    console.log(themed(definition.menuHint, 'accent'));
    return;
  }
  const prompted = (definition.arguments ?? []).filter((argument) => argument.menuPrompt);
  const questions = prompted.map(({ name, menuPrompt = '', choices, defaultValue }) => (choices
    ? { type: 'list' as const, name, message: menuPrompt, choices: [...choices], default: defaultValue }
    : { type: 'input' as const, name, message: menuPrompt, default: defaultValue }));
  const answers: Record<string, string | undefined> = questions.length > 0 ? await inquirer.prompt(questions) : {};
  const missingRequired = prompted.some((argument) => argument.required && !answers[argument.name]);
  if (missingRequired) return;
  await definition.run(answers, {});
}

export async function menu() {
  const commands = menuChoices();
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
        const definition = findBuiltInCommand(cmd);
        if (definition) await runFromMenu(definition);
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
