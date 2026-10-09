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
  options: [
    { flags: '--base <git-ref>', description: 'Review commits from the merge base of this ref and HEAD' },
    { flags: '--include <globs...>', description: 'Review only changed paths matching these globs (policy .dhruv-check.json: include, default "**")' },
    { flags: '--exclude <globs...>', description: 'Leave out changed paths matching these globs (policy: exclude, default none)' },
    { flags: '--max-changed-files <count>', description: 'Review at most this many changed files, in path order (policy: maxChangedFiles, default 50)' },
    { flags: '--max-file-bytes <bytes>', description: 'Send at most this much of one file\'s patch (policy: maxFileBytes, default 65536)' },
    { flags: '--max-total-bytes <bytes>', description: 'Send at most this much patch in total (policy: maxTotalBytes, default 262144)' },
    { flags: '--min-severity <severity>', description: 'Show findings of this severity or higher: critical, high, medium, low, info (policy: minSeverity, default info)' },
    { flags: '--strict-coverage', description: 'Exit 2 when relevant changed source was skipped or truncated' },
  ],
  examples: ['dhruv check --base origin/main', 'dhruv check --base origin/main --exclude "dist/**" --min-severity medium', 'dhruv --json check --base origin/main --strict-coverage'],
  menuHint: 'Run: dhruv check --base <git-ref>',
  run: async (_args, options) => {
    const { check } = await import('../check.js');
    await check(options as CheckOptions);
  },
};
