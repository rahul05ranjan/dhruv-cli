/**
 * Command Presentation for `check`: one typed result, rendered as text or JSON.
 *
 * Text goes to stdout on success and stderr on failure; an incomplete review under
 * `--strict-coverage` writes its report to stdout and the reason to stderr. JSON is
 * exactly one object on stdout for every outcome, with no banner, spinner or source text.
 */
import { loadConfig } from '../config/config.js';
import { CHECK_SEVERITIES, type CheckFinding, type FindingSummary } from './check-findings.js';
import type { EffectiveCheckPolicy } from './check-policy.js';
import { EXCLUSION_REASONS, type RangeCoverage, type RangeExclusion } from './committed-range.js';

export const CHECK_SCHEMA_VERSION = 1;

/**
 * Process exit codes of `check`: `ok` is an advisory analysis whatever it found,
 * `failure` is invalid input or configuration (including the policy) or a runtime
 * failure (including a timeout), `incomplete` is relevant changed source left
 * unreviewed while `--strict-coverage` is set, `cancelled` is a user interrupt.
 */
export const CHECK_EXIT = { ok: 0, failure: 1, incomplete: 2, cancelled: 130 } as const;

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
  /** The policy the run applied, after command-line overrides. */
  policy: EffectiveCheckPolicy;
  coverage: RangeCoverage;
  /** Changed files that were skipped or truncated, with the reason. */
  exclusions: RangeExclusion[];
}

/**
 * `ok` and `incomplete` carry the analysis; `incomplete` is the same analysis
 * under `--strict-coverage` when coverage is not complete. A failed run reports
 * no findings; range facts are present when it got that far.
 */
export type CheckResult =
  | ({ status: 'ok' | 'incomplete'; summary: FindingSummary; findings: CheckFinding[] } & CheckRangeFacts)
  | ({ status: 'error' | 'cancelled'; error: CheckError } & Partial<CheckRangeFacts>);

function short(commit: string): string {
  return commit.slice(0, 12);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Escape terminal controls and invisible format marks without changing JSON values. */
function terminalSafe(value: string): string {
  return Array.from(value, (character) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
    ? `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}`
    : character).join('');
}

function renderText(result: CheckResult): { stdout?: string; stderr?: string } {
  if ('error' in result) {
    const hint = result.error.hint ? `\n${terminalSafe(result.error.hint)}` : '';
    return { stderr: `ERROR ${terminalSafe(result.error.message)}${hint}\n` };
  }

  const { refs, policy, coverage, exclusions, findings, summary } = result;
  const overrides = policy.overrides.length > 0 ? `, overridden for this run: ${policy.overrides.join(', ')}` : '';
  const lines = [
    `Dhruv check: ${terminalSafe(refs.base.ref)} (${short(refs.base.commit)}) .. HEAD (${short(refs.head)}), merge base ${short(refs.mergeBase)}`,
    `Base commit ${refs.base.commit}`,
    `Merge base ${refs.mergeBase}`,
    `Head commit ${refs.head}`,
    `Model ${terminalSafe(result.model)}`,
    `Policy ${policy.file ?? 'built-in defaults'} (base commit ${short(policy.sourceCommit)})${overrides}`,
    '',
  ];
  if (coverage.changedFiles === 0) {
    lines.push('No changes in this range.');
  } else {
    lines.push(`Analyzed ${coverage.analyzedFiles} of ${plural(coverage.changedFiles, 'changed file')}${coverage.complete ? '' : ' (coverage incomplete)'}.`);
  }
  if (coverage.analyzedFiles > 0) {
    const counts = CHECK_SEVERITIES.filter((severity) => summary.bySeverity[severity] > 0).map((severity) => `${summary.bySeverity[severity]} ${severity}`);
    // Zero findings must never read as a clean review of source that was not looked at.
    const none = coverage.complete ? 'No findings.' : 'No findings in the analyzed changes. Coverage is incomplete, so this is not a full review.';
    lines.push(findings.length === 0 ? none : `${plural(findings.length, 'finding')}: ${counts.join(', ')}.`);
  }
  for (const finding of findings) {
    lines.push(
      '',
      `[${finding.severity.toUpperCase()}] ${terminalSafe(finding.path)}:${finding.line}`,
      `  Reason: ${terminalSafe(finding.reason)}`,
      `  Evidence: ${terminalSafe(finding.evidence)}`,
      `  Recommendation: ${terminalSafe(finding.recommendation)}`,
    );
  }
  const { invalid, offDiff, duplicate, belowMinSeverity } = summary.omitted;
  if (invalid + offDiff + duplicate + belowMinSeverity > 0) lines.push('');
  if (invalid + offDiff > 0) {
    lines.push(`Omitted ${plural(invalid + offDiff, 'model candidate')}: ${invalid} invalid, ${offDiff} not on a changed line.`);
  }
  if (duplicate > 0) lines.push(`Collapsed ${plural(duplicate, 'duplicate candidate')}.`);
  if (belowMinSeverity > 0) lines.push(`Hidden ${plural(belowMinSeverity, 'finding')} below ${policy.minSeverity} severity.`);

  const skipped = exclusions.filter(({ reason }) => reason !== 'truncated');
  const truncated = exclusions.filter(({ reason }) => reason === 'truncated');
  if (skipped.length > 0) {
    const counts = EXCLUSION_REASONS.filter((reason) => reason !== 'truncated' && coverage.byReason[reason] > 0).map((reason) => `${coverage.byReason[reason]} ${reason}`);
    lines.push('', `Not analyzed (${skipped.length}): ${counts.join(', ')}`);
    for (const { path, reason } of skipped) lines.push(`  ${terminalSafe(path)}  (${reason})`);
  }
  if (truncated.length > 0) {
    lines.push('', `Partially analyzed (${truncated.length}):`);
    for (const { path, reason } of truncated) lines.push(`  ${terminalSafe(path)}  (${reason})`);
  }

  const stderr = result.status === 'incomplete'
    ? 'ERROR Coverage is incomplete: relevant changed source was skipped or truncated (--strict-coverage).\n'
    : undefined;
  return { stdout: `${lines.join('\n')}\n`, stderr };
}

/** One object with a fixed key order; keys that do not apply to the outcome are left out. */
function renderJson(result: CheckResult): string {
  const { status, refs, model, policy, coverage, exclusions } = result;
  const analysis = 'error' in result ? {} : { summary: result.summary, findings: result.findings };
  const error = 'error' in result ? result.error : undefined;
  return JSON.stringify({ schemaVersion: CHECK_SCHEMA_VERSION, command: 'check', status, refs, model, policy, ...analysis, coverage, exclusions, error });
}

const EXIT_BY_STATUS: Record<CheckResult['status'], number> = {
  ok: CHECK_EXIT.ok,
  incomplete: CHECK_EXIT.incomplete,
  error: CHECK_EXIT.failure,
  cancelled: CHECK_EXIT.cancelled,
};

/** Writes the result and sets the exit code. Never throws on I/O. */
export function presentCheckResult(result: CheckResult): void {
  process.exitCode = EXIT_BY_STATUS[result.status];

  if (loadConfig().responseFormat === 'json') {
    process.stdout.write(`${renderJson(result)}\n`);
    return;
  }
  const { stdout, stderr } = renderText(result);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
