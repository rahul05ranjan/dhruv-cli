/**
 * Findings of `check`: the model proposes candidates, and only those grounded in
 * the analyzed range are reported. Validation guarantees location and structure,
 * not that the model is right.
 *
 * Like Source Ingestion, this states facts and has no side effects.
 */
import type { RangeFile } from './committed-range.js';

/**
 * The severities a finding may carry, most severe first:
 * `critical` (exploitable flaw, data loss or corruption), `high` (likely bug or
 * security weakness), `medium` (correctness or maintainability risk), `low`
 * (minor issue) and `info` (observation that needs no action).
 */
export const CHECK_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

export interface CheckFinding {
  /** Repository-relative POSIX path of an analyzed file. */
  path: string;
  /** New-side line added or modified by the range. */
  line: number;
  severity: CheckSeverity;
  /** One-line summary of the problem. */
  reason: string;
  /** What in the change supports the finding. */
  evidence: string;
  recommendation: string;
}

export interface FindingSummary {
  /** Findings reported after validation and deduplication. */
  findings: number;
  bySeverity: Record<CheckSeverity, number>;
  /** Candidates the model returned; equals `findings` plus everything omitted. */
  candidates: number;
  omitted: {
    /** Malformed, incomplete or carrying an undocumented severity. */
    invalid: number;
    /** Not on a changed line of an analyzed file. */
    offDiff: number;
    /** Repeats of a reported finding. */
    duplicate: number;
  };
}

export type FindingsOutcome =
  | { ok: true; findings: CheckFinding[]; summary: FindingSummary }
  | { ok: false; message: string };

const MAX_REASON_LENGTH = 200;
const MAX_DETAIL_LENGTH = 500;

export function summarizeFindings(findings: CheckFinding[], omitted = { invalid: 0, offDiff: 0, duplicate: 0 }): FindingSummary {
  const bySeverity = Object.fromEntries(CHECK_SEVERITIES.map((severity) => [severity, 0])) as Record<CheckSeverity, number>;
  for (const { severity } of findings) bySeverity[severity]++;
  return {
    findings: findings.length,
    bySeverity,
    candidates: findings.length + omitted.invalid + omitted.offDiff + omitted.duplicate,
    omitted,
  };
}

/** Reads the response as JSON, tolerating prose or a code fence around the object. */
function parseResponse(response: string): unknown {
  const text = response.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  for (const candidate of [text, start !== -1 && end > start ? text.slice(start, end + 1) : undefined]) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  return undefined;
}

/** One printable line: control characters and line breaks never reach the terminal. */
function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseLine(value: unknown): number | undefined {
  const line = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof line === 'number' && Number.isSafeInteger(line) ? line : undefined;
}

function parseSeverity(value: unknown): CheckSeverity | undefined {
  const severity = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CHECK_SEVERITIES.find((known) => known === severity);
}

function compare<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Findings that agree on these describe the same issue. */
function issueKey(finding: CheckFinding): string {
  return finding.reason.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Validates the model response against the analyzed files. The run fails when
 * the response as a whole is unusable; single bad candidates are only counted.
 */
export function readFindings(response: string, files: RangeFile[]): FindingsOutcome {
  const parsed = parseResponse(response);
  const candidates = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { findings?: unknown }).findings
    : undefined;
  if (!Array.isArray(candidates)) {
    return { ok: false, message: 'The model response was not a JSON object with a "findings" list.' };
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const omitted = { invalid: 0, offDiff: 0, duplicate: 0 };
  const valid: CheckFinding[] = [];

  for (const candidate of candidates as unknown[]) {
    const fields: Record<string, unknown> = typeof candidate === 'object' && candidate !== null ? candidate as Record<string, unknown> : {};
    const line = parseLine(fields.line);
    const severity = parseSeverity(fields.severity);
    const reason = cleanText(fields.reason, MAX_REASON_LENGTH);
    const evidence = cleanText(fields.evidence, MAX_DETAIL_LENGTH);
    const recommendation = cleanText(fields.recommendation, MAX_DETAIL_LENGTH);
    if (typeof fields.path !== 'string' || line === undefined || !severity || !reason || !evidence || !recommendation) {
      omitted.invalid++;
      continue;
    }

    // Only the spelling is normalized; the path must still name an analyzed file.
    const file = byPath.get(fields.path) ?? byPath.get(fields.path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''));
    if (!file || !file.changedLines.some(({ start, end }) => line >= start && line <= end)) {
      omitted.offDiff++;
      continue;
    }
    valid.push({ path: file.path, line, severity, reason, evidence, recommendation });
  }

  // Sorting first makes the result, and which duplicate survives, independent of the model's order.
  const rank = (finding: CheckFinding) => CHECK_SEVERITIES.indexOf(finding.severity);
  valid.sort((a, b) =>
    compare(a.path, b.path) || compare(a.line, b.line) || compare(rank(a), rank(b)) || compare(issueKey(a), issueKey(b))
    || compare(a.reason, b.reason) || compare(a.evidence, b.evidence) || compare(a.recommendation, b.recommendation));

  const seen = new Set<string>();
  const findings = valid.filter((finding) => {
    const key = JSON.stringify([finding.path, finding.line, issueKey(finding)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  omitted.duplicate = valid.length - findings.length;

  return { ok: true, findings, summary: summarizeFindings(findings, omitted) };
}
