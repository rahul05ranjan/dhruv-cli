import type { BuiltInCommand } from '../built-in-commands.js';
import { review, type ReviewOptions } from '../review.js';
import { optimize } from '../optimize.js';
import { securityCheck, type SecurityCheckOptions } from '../security-check.js';
import { generate, type GenerateOptions } from '../generate.js';

/** Suggested generate types for the menu and completion. The command line accepts any type. */
const generateTypes = ['tests', 'documentation', 'docs', 'component'] as const;

/** Source-driven commands: each loads a file, directory or diff and asks the AI about it. */
export const sourceCommands: readonly BuiltInCommand[] = [
  {
    name: 'review',
    description: 'Review code in a file or directory',
    menuLabel: 'Review',
    arguments: [{ name: 'fileOrDir', required: true, completeFiles: true, menuPrompt: 'Enter file or directory path to review:' }],
    options: [{ flags: '--diff', description: 'Review the current uncommitted git diff' }],
    run: ({ fileOrDir = '' }, options) => review(fileOrDir, options as ReviewOptions),
  },
  {
    name: 'optimize',
    description: 'Optimize a file (e.g., package.json)',
    menuLabel: 'Optimize',
    arguments: [{ name: 'file', required: true, completeFiles: true, menuPrompt: 'Enter file path to optimize:' }],
    run: ({ file = '' }) => optimize(file),
  },
  {
    name: 'security-check',
    description: 'Run a security check on code',
    menuLabel: 'Security Check',
    arguments: [{
      name: 'fileOrDir',
      required: false,
      defaultValue: '.',
      completeFiles: true,
      menuPrompt: 'Enter file or directory path to check (or press enter for current directory):',
    }],
    options: [{ flags: '--strict', description: 'Exit with failure when high-confidence findings are detected' }],
    run: ({ fileOrDir }, options) => securityCheck(fileOrDir, options as SecurityCheckOptions),
  },
  {
    name: 'generate',
    description: 'Generate code/tests for a file',
    menuLabel: 'Generate',
    arguments: [
      { name: 'type', required: true, choices: generateTypes, menuPrompt: 'What would you like to generate?' },
      { name: 'target', required: true, completeFiles: true, menuPrompt: 'Enter target file path:' },
    ],
    options: [
      { flags: '--apply', description: 'Write generated tests to disk (preview is the default)' },
      { flags: '--output <path>', description: 'Write generated tests to this path' },
      { flags: '--overwrite', description: 'Allow replacing an existing output file' },
    ],
    run: ({ type = '', target = '' }, options) => generate(type, target, options as GenerateOptions),
  },
];
