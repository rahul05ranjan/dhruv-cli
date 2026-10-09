/**
 * Command Presentation for `check`: one typed result, rendered as text or JSON.
 *
 * Text goes to stdout on success and stderr on failure. JSON is exactly one object
 * on stdout for success and failure alike, with no banner, spinner or source text.
 */
import { loadConfig } from '../config/config.js';
import { CHECK_SEVERITIES, type CheckFinding, type FindingSummary } from './check-findings.js';
import type { RangeCoverage, SkippedFile } from './committed-range.js';

export const CHECK_SCHEMA_VERSION = 1;

/**
 * Process exit codes of `check`: `ok` is a complete advisory analysis whatever it
 * found, `failure` is invalid input or configuration or a runtime failure
 * (including a timeout), `cancelled` is a user interrupt.
 */
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

/** What is known about the reviewed range once Source Ingestion succeeded. */
export interface CheckRangeFacts {
  refs: CheckRefs;
  model: string;
  coverage: RangeCoverage;
  /** Changed files that were not analyzed, with the reason. */
  exclusions: SkippedFile[];
}

/** A failed run reports no findings; range facts are present when it got that far. */
export type CheckResult =
  | ({ status: 'ok'; summary: FindingSummary; findings: CheckFinding[] } & CheckRangeFacts)
  | ({ status: 'error' | 'cancelled'; error: CheckError } & Partial<CheckRangeFacts>);

function short(commit: string): string {
  return commit.slice(0, 12);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function renderText(result: CheckResult): { stdout?: string; stderr?: string } {
  if (result.status !== 'ok') {
    const hint = result.error.hint ? `\n${result.error.hint}` : '';
    return { stderr: `ERROR ${result.error.message}${hint}\n` };
  }

  const { refs, coverage, exclusions, findings, summary } = result;
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
  if (coverage.analyzedFiles > 0) {
    const counts = CHECK_SEVERITIES.filter((severity) => summary.bySeverity[severity] > 0).map((severity) => `${summary.bySeverity[severity]} ${severity}`);
    lines.push(findings.length === 0 ? 'No findings.' : `${plural(findings.length, 'finding')}: ${counts.join(', ')}.`);
  }
  for (const finding of findings) {
    lines.push(
      '',
      `[${finding.severity.toUpperCase()}] ${finding.path}:${finding.line}`,
      `  Reason: ${finding.reason}`,
      `  Evidence: ${finding.evidence}`,
      `  Recommendation: ${finding.recommendation}`,
    );
  }
  const { invalid, offDiff, duplicate } = summary.omitted;
  if (invalid + offDiff + duplicate > 0) lines.push('');
  if (invalid + offDiff > 0) {
    lines.push(`Omitted ${plural(invalid + offDiff, 'model candidate')}: ${invalid} invalid, ${offDiff} not on a changed line.`);
  }
  if (duplicate > 0) lines.push(`Collapsed ${plural(duplicate, 'duplicate candidate')}.`);
  if (exclusions.length > 0) {
    lines.push('', 'Not analyzed:');
    for (const { path, reason } of exclusions) lines.push(`  ${path}  (${reason})`);
  }
  return { stdout: `${lines.join('\n')}\n` };
}

/** One object with a fixed key order; keys that do not apply to the outcome are left out. */
function renderJson(result: CheckResult): string {
  const { status, refs, model, coverage, exclusions } = result;
  const analysis = result.status === 'ok' ? { summary: result.summary, findings: result.findings } : {};
  const error = result.status === 'ok' ? undefined : result.error;
  return JSON.stringify({ schemaVersion: CHECK_SCHEMA_VERSION, command: 'check', status, refs, model, ...analysis, coverage, exclusions, error });
}

/** Writes the result and sets the exit code. Never throws on I/O. */
export function presentCheckResult(result: CheckResult): void {
  process.exitCode = result.status === 'ok' ? CHECK_EXIT.ok : result.status === 'cancelled' ? CHECK_EXIT.cancelled : CHECK_EXIT.failure;

  if (loadConfig().responseFormat === 'json') {
    process.stdout.write(`${renderJson(result)}\n`);
    return;
  }
  const { stdout, stderr } = renderText(result);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
