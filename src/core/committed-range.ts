/**
 * Source Ingestion for a committed Git range: the changes from the merge base of
 * a base ref and `HEAD` up to `HEAD`. Only committed content is read, so staged
 * and unstaged work never takes part.
 *
 * Like `ingestSource`, ingestion states facts and has no side effects: it does not
 * print, set exit codes, or ask the AI. Presentation belongs to the caller.
 */
import { spawnSync } from 'child_process';
import { CODE_FILE } from './source-ingestion.js';

export interface LineRange {
  start: number;
  end: number;
}

export interface CommittedRangeLimits {
  /** Changed files beyond this count (in path order) are skipped. */
  maxChangedFiles: number;
  /** A file whose patch is larger than this is skipped. */
  maxFileBytes: number;
  /** Files that would push the analyzed patches past this total are skipped. */
  maxTotalBytes: number;
}

export const DEFAULT_RANGE_LIMITS: CommittedRangeLimits = {
  maxChangedFiles: 50,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
};

export type RangeFileStatus = 'added' | 'modified' | 'renamed' | 'copied' | 'deleted' | 'type-changed';

export interface RangeFile {
  /** Repository-relative POSIX path on the new side. */
  path: string;
  /** Previous path for renames and copies. */
  oldPath?: string;
  status: RangeFileStatus;
  /** New-side lines added or modified by the range, as ascending ranges. */
  changedLines: LineRange[];
  /** Unified patch with `RANGE_CONTEXT_LINES` lines of context. */
  patch: string;
}

/**
 * Why a changed file was not analyzed. `deleted`, `binary`, `unsupported` and
 * `no-line-changes` are irrelevant to a source review; the others mean relevant
 * source went unreviewed and coverage is incomplete.
 */
export type SkipReason = 'deleted' | 'binary' | 'unsupported' | 'no-line-changes' | 'oversized' | 'file-limit' | 'total-limit';

const COVERAGE_BREAKING: readonly SkipReason[] = ['oversized', 'file-limit', 'total-limit'];

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface RangeCoverage {
  changedFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  /** False when relevant changed source was skipped. */
  complete: boolean;
}

export interface CommittedRange {
  base: { ref: string; commit: string };
  mergeBase: string;
  head: string;
  /** Analyzed files, in path order. */
  files: RangeFile[];
  /** Every changed file that was not analyzed, in path order. */
  skipped: SkippedFile[];
  coverage: RangeCoverage;
}

export type CommittedRangeFailureReason =
  | 'invalid-ref'
  | 'unknown-ref'
  | 'no-merge-base'
  | 'git-unavailable'
  | 'not-a-repository'
  | 'git-error';

export type CommittedRangeOutcome =
  | ({ ok: true } & CommittedRange)
  | { ok: false; reason: CommittedRangeFailureReason; message: string };

export const RANGE_CONTEXT_LINES = 10;

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

interface GitResult {
  status: number | null;
  stdout: string;
  missing: boolean;
}

/** Runs Git without a shell. Output is never decorated, localized or passed through external drivers. */
function git(cwd: string, args: string[]): GitResult {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_EXTERNAL_DIFF;
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return { status: result.status, stdout: result.stdout ?? '', missing: code === 'ENOENT' };
}

function failure(reason: CommittedRangeFailureReason, message: string): CommittedRangeOutcome {
  return { ok: false, reason, message };
}

const STATUS_NAMES: Record<string, RangeFileStatus> = {
  A: 'added', M: 'modified', R: 'renamed', C: 'copied', D: 'deleted', T: 'type-changed',
};

interface RawEntry {
  status: RangeFileStatus;
  path: string;
  oldPath?: string;
}

/** Parses `git diff --raw -z`: `:modes shas STATUS\0path\0` with a second path for renames and copies. */
function parseRaw(output: string): RawEntry[] {
  const fields = output.split('\0');
  const entries: RawEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const meta = fields[index++];
    if (!meta.startsWith(':')) continue;
    const letter = meta.split(' ').pop()?.[0] ?? '';
    const status = STATUS_NAMES[letter];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (status && path) entries.push({ status, path, oldPath });
    } else {
      const path = fields[index++];
      if (status && path) entries.push({ status, path });
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Collects the new-side line numbers of `+` lines from a unified patch. */
function parseChangedLines(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  let line = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      line = Number(header[1]);
      inHunk = true;
    } else if (!inHunk || text.startsWith('\\')) {
      continue;
    } else if (text.startsWith('+')) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === line - 1) last.end = line;
      else ranges.push({ start: line, end: line });
      line++;
    } else if (text.startsWith(' ')) {
      line++;
    }
  }
  return ranges;
}

export interface IngestCommittedRangeOptions {
  base: string;
  cwd: string;
  limits?: Partial<CommittedRangeLimits>;
}

export function ingestCommittedRange({ base, cwd, limits: overrides }: IngestCommittedRangeOptions): CommittedRangeOutcome {
  const limits = { ...DEFAULT_RANGE_LIMITS, ...overrides };

  if (!base.trim() || base.startsWith('-')) {
    return failure('invalid-ref', `"${base}" is not a valid Git ref for --base.`);
  }

  const toplevel = git(cwd, ['rev-parse', '--show-toplevel']);
  if (toplevel.missing) return failure('git-unavailable', 'Git is not available. Install Git and make sure it is on your PATH.');
  if (toplevel.status !== 0) return failure('not-a-repository', `"${cwd}" is not a Git repository.`);
  const root = toplevel.stdout.trim();

  const baseCommit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]);
  if (baseCommit.status !== 0) {
    return failure('unknown-ref', `Unknown Git ref "${base}". Fetch it first (in CI, check out with enough history and fetch the base branch).`);
  }
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) return failure('git-error', 'HEAD does not point to a commit.');
  const baseSha = baseCommit.stdout.trim();
  const headSha = head.stdout.trim();

  const mergeBase = git(root, ['merge-base', baseSha, headSha]);
  if (mergeBase.status === 1) {
    return failure('no-merge-base', `No merge base between "${base}" and HEAD. In a shallow checkout, fetch more history (for example, fetch-depth: 0).`);
  }
  if (mergeBase.status !== 0) return failure('git-error', `Git could not compute the merge base of "${base}" and HEAD.`);
  const mergeBaseSha = mergeBase.stdout.trim();

  const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];
  const raw = git(root, ['diff', '--raw', '-z', ...diffFlags, mergeBaseSha, headSha, '--']);
  if (raw.status !== 0) return failure('git-error', 'Git could not list the changed files.');
  const entries = parseRaw(raw.stdout);

  const files: RangeFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;
  const skip = (path: string, reason: SkipReason) => skipped.push({ path, reason });

  entries.forEach((entry, index) => {
    if (entry.status === 'deleted') return skip(entry.path, 'deleted');
    if (!CODE_FILE.test(entry.path)) return skip(entry.path, 'unsupported');
    if (index >= limits.maxChangedFiles) return skip(entry.path, 'file-limit');

    const paths = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
    const diff = git(root, ['diff', `--unified=${RANGE_CONTEXT_LINES}`, ...diffFlags, mergeBaseSha, headSha, '--', ...paths]);
    if (diff.status !== 0) return skip(entry.path, 'no-line-changes');
    if (/^Binary files /m.test(diff.stdout) || /^GIT binary patch/m.test(diff.stdout)) return skip(entry.path, 'binary');

    const start = diff.stdout.search(/^@@ /m);
    const patch = start === -1 ? '' : diff.stdout.slice(start);
    const changedLines = parseChangedLines(patch);
    if (changedLines.length === 0) return skip(entry.path, 'no-line-changes');

    const bytes = Buffer.byteLength(patch);
    if (bytes > limits.maxFileBytes) return skip(entry.path, 'oversized');
    if (totalBytes + bytes > limits.maxTotalBytes) return skip(entry.path, 'total-limit');
    totalBytes += bytes;
    files.push({ path: entry.path, oldPath: entry.oldPath, status: entry.status, changedLines, patch });
  });

  return {
    ok: true,
    base: { ref: base, commit: baseSha },
    mergeBase: mergeBaseSha,
    head: headSha,
    files,
    skipped,
    coverage: {
      changedFiles: entries.length,
      analyzedFiles: files.length,
      skippedFiles: skipped.length,
      complete: !skipped.some(({ reason }) => COVERAGE_BREAKING.includes(reason)),
    },
  };
}
