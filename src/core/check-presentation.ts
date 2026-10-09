/**
 * Command Presentation for `check`: one typed result, rendered as text or JSON.
 *
 * Text goes to stdout on success and stderr on failure. JSON is exactly one object
 * on stdout for success and failure alike, with no banner, spinner or source text.
 */
import { loadConfig } from '../config/config.js';
import type { RangeCoverage, SkippedFile } from './committed-range.js';

export const CHECK_SCHEMA_VERSION = 1;

/** Process exit codes of `check`. */
export const CHECK_EXIT = { ok: 0, failure: 1, cancelled: 130 } as const;

export interface CheckRefs {
  base: { ref: string; commit: string };
  mergeBase: string;
  head: string;
}

export interface CheckError {
  kind: string;
  message: string;
  hint?: string;
}

export type CheckResult =
  | {
    status: 'ok';
    refs: CheckRefs;
    model: string;
    coverage: RangeCoverage;
    skipped: SkippedFile[];
    /** Free-text advisory review; absent when there was nothing to analyze. */
    review?: string;
  }
  | { status: 'error' | 'cancelled'; error: CheckError; refs?: CheckRefs; model?: string };

function short(commit: string): string {
  return commit.slice(0, 12);
}

function renderText(result: CheckResult): { stdout?: string; stderr?: string } {
  if (result.status !== 'ok') {
    const hint = result.error.hint ? `\n${result.error.hint}` : '';
    return { stderr: `ERROR ${result.error.message}${hint}\n` };
  }

  const { refs, coverage, skipped } = result;
  const lines = [
    `Dhruv check: ${refs.base.ref} (${short(refs.base.commit)}) .. HEAD (${short(refs.head)}), merge base ${short(refs.mergeBase)}`,
    `Base commit ${refs.base.commit}`,
    `Merge base ${refs.mergeBase}`,
    `Head commit ${refs.head}`,
    `Model ${result.model}`,
    '',
  ];
  if (coverage.changedFiles === 0) {
    lines.push('No changes in this range.');
  } else {
    lines.push(`Analyzed ${coverage.analyzedFiles} of ${coverage.changedFiles} changed files${coverage.complete ? '' : ' (coverage incomplete)'}.`);
  }
  if (result.review !== undefined) lines.push('', result.review.trim());
  if (skipped.length > 0) {
    lines.push('', 'Not analyzed:');
    for (const { path, reason } of skipped) lines.push(`  ${path}  (${reason})`);
  }
  return { stdout: `${lines.join('\n')}\n` };
}

/** Writes the result and sets the exit code. Never throws on I/O. */
export function presentCheckResult(result: CheckResult): void {
  process.exitCode = result.status === 'ok' ? CHECK_EXIT.ok : result.status === 'cancelled' ? CHECK_EXIT.cancelled : CHECK_EXIT.failure;

  if (loadConfig().responseFormat === 'json') {
    process.stdout.write(`${JSON.stringify({ schemaVersion: CHECK_SCHEMA_VERSION, command: 'check', ...result })}\n`);
    return;
  }
  const { stdout, stderr } = renderText(result);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
