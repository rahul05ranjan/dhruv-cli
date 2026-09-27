import type { BuiltInCommand } from '../built-in-commands.js';
import { run, type RunCommandOptions } from '../run.js';

export const agentCommands: readonly BuiltInCommand[] = [
  {
    name: 'run',
    description: 'Execute a shell command with optional autonomous self-healing',
    menuLabel: 'Run Command',
    arguments: [
      {
        name: 'command',
        required: true,
        description: 'Shell command to execute (e.g. "npm test")',
        menuPrompt: 'Enter command to run:',
      },
    ],
    options: [
      {
        flags: '--auto-fix',
        description: 'Automatically diagnose and repair errors when command fails',
      },
      {
        flags: '--apply',
        description: 'Apply fixes directly without interactive confirmation',
      },
      {
        flags: '--max-iterations <count>',
        description: 'Maximum self-healing repair attempts (default: 3)',
      },
    ],
    examples: [
      'dhruv run "npm test"',
      'dhruv run "npm test" --auto-fix',
      'dhruv run "cargo build" --auto-fix --apply',
    ],
    run: ({ command = '' }, options) => run(command, options as RunCommandOptions),
  },
];
