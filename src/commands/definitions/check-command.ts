import type { BuiltInCommand } from '../built-in-commands.js';
import type { CheckOptions } from '../check.js';

/**
 * Kept in its own file so the isolated `check` entry can register it without
 * loading the other command modules. The command module is imported on demand.
 */
export const checkCommand: BuiltInCommand = {
  name: 'check',
  description: 'Review committed changes since a base ref (advisory)',
  menuLabel: 'Check',
  options: [{ flags: '--base <git-ref>', description: 'Review commits from the merge base of this ref and HEAD' }],
  examples: ['dhruv check --base origin/main'],
  menuHint: 'Run: dhruv check --base <git-ref>',
  run: async (_args, options) => {
    const { check } = await import('../check.js');
    await check(options as CheckOptions);
  },
};
