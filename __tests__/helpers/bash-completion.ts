import { it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { completionScript } from '../../src/commands/completion';

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/** `it`, skipped when bash is not installed. */
export const itWithBash = bashAvailable ? it : it.skip;

/** Runs the generated bash completion for the given words (the last word is the one being completed). */
export function bashCompletions(...words: string[]): string[] {
  const result = spawnSync('bash', ['-c', [
    'eval "$DHRUV_COMPLETION"',
    'COMP_WORDS=(dhruv "$@")',
    'COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))',
    '_dhruv_completion',
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join('\n'), 'bash', ...words], {
    env: { ...process.env, DHRUV_COMPLETION: completionScript('bash') },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
