/**
 * Source Ingestion for a committed Git range: the changes from the merge base of
 * a base ref and `HEAD` up to `HEAD`. Only committed content is read, so staged
 * and unstaged work never takes part.
 *
 * Like `ingestSource`, ingestion states facts and has no side effects: it does not
 * print, set exit codes, or ask the AI. Presentation belongs to the caller.
 */
import { spawnSync } from 'child_process';
import { pathSelector } from './path-glob.js';
import { CODE_FILE } from './source-ingestion.js';

export interface LineRange {
  start: number;
  end: number;
}

export interface CommittedRangeLimits {
  /** Selected changed files beyond this count (in path order) are skipped. */
  maxChangedFiles: number;
  /** A file's patch is cut at the last hunk boundary within this size, or skipped when no changed hunk fits. */
  maxFileBytes: number;
  /** Files that would push the analyzed patches past this total are skipped. */
  maxTotalBytes: number;
}

/** Which changed files take part, and how much of them. Globs follow `path-glob.ts`. */
export interface RangeSelection extends CommittedRangeLimits {
  include: readonly string[];
  exclude: readonly string[];
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
 * Why a changed file was not analyzed in full, in reporting order.
 *
 * `ignored` (left out by the include and exclude globs), `deleted`, `binary`,
 * `unsupported` (not a source file type) and `no-line-changes` (a pure rename or
 * mode change) are irrelevant to a source review. The others mean relevant source
 * went unreviewed and coverage is incomplete: `unreadable` (Git could not produce
 * the patch), `oversized` (not even the first changed hunk fits the per-file
 * limit), `file-limit`, `total-limit`, and `truncated` (analyzed up to the
 * per-file limit; the remaining hunks were not).
 */
export const EXCLUSION_REASONS = [
  'ignored', 'deleted', 'binary', 'unsupported', 'no-line-changes',
  'unreadable', 'oversized', 'file-limit', 'total-limit', 'truncated',
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** The reasons that mean relevant source went unreviewed. */
export const COVERAGE_BREAKING: readonly ExclusionReason[] = ['unreadable', 'oversized', 'file-limit', 'total-limit', 'truncated'];

export interface RangeExclusion {
  path: string;
  reason: ExclusionReason;
}

export interface RangeCoverage {
  changedFiles: number;
  /** Files sent for analysis, truncated ones included. */
  analyzedFiles: number;
  /** Files not analyzed at all. */
  skippedFiles: number;
  /** Analyzed files whose patch was cut short. */
  truncatedFiles: number;
  /** False when relevant changed source was skipped or truncated. */
  complete: boolean;
  /** How many exclusions carry each reason. */
  byReason: Record<ExclusionReason, number>;
}

/** The commits a range runs between, resolved once so everything reads the same `HEAD`. */
export interface ResolvedRange {
  /** Top-level directory of the repository. */
  root: string;
  base: { ref: string; commit: string };
  mergeBase: string;
  head: string;
}

export interface CommittedRange extends Omit<ResolvedRange, 'root'> {
  /** Analyzed files, in path order. */
  files: RangeFile[];
  /** Every changed file that was skipped or truncated, in path order. */
  exclusions: RangeExclusion[];
  coverage: RangeCoverage;
}

export type CommittedRangeFailureReason =
  | 'invalid-ref'
  | 'unknown-ref'
  | 'no-merge-base'
  | 'git-unavailable'
  | 'not-a-repository'
  | 'git-error';

interface CommittedRangeFailure {
  ok: false;
  reason: CommittedRangeFailureReason;
  message: string;
}

export type ResolvedRangeOutcome = ({ ok: true } & ResolvedRange) | CommittedRangeFailure;

export type CommittedRangeOutcome = ({ ok: true } & CommittedRange) | CommittedRangeFailure;

export type CommittedFileOutcome =
  | { status: 'absent' }
  | { status: 'read'; content: string }
  | { status: 'unusable'; problem: string };

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

function failure(reason: CommittedRangeFailureReason, message: string): CommittedRangeFailure {
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

/** Resolves `base`, `HEAD` and their merge base. Fails when the range cannot be established. */
export function resolveCommittedRange({ base, cwd }: { base: string; cwd: string }): ResolvedRangeOutcome {
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

  return { ok: true, root, base: { ref: base, commit: baseSha }, mergeBase: mergeBase.stdout.trim(), head: headSha };
}

/**
 * Reads a repository-relative file from the head commit, never from the working
 * tree. Only a regular file within the size limit is read, so a symbolic link is
 * not followed and nothing outside the repository can be reached.
 */
export function readCommittedFile(range: ResolvedRange, path: string, maxBytes: number): CommittedFileOutcome {
  const unusable = (problem: string): CommittedFileOutcome => ({ status: 'unusable', problem });

  const entry = git(range.root, ['ls-tree', '-z', range.head, '--', path]);
  if (entry.status !== 0) return unusable('could not be read from the head commit');
  if (!entry.stdout) return { status: 'absent' };
  const [mode, type, object] = entry.stdout.split('\t')[0].split(' ');
  if (type !== 'blob' || !mode.startsWith('100')) return unusable('must be a regular file');

  const size = git(range.root, ['cat-file', '-s', object]);
  if (size.status !== 0) return unusable('could not be read from the head commit');
  if (Number(size.stdout) > maxBytes) return unusable(`is larger than ${maxBytes} bytes`);

  const blob = git(range.root, ['cat-file', 'blob', object]);
  return blob.status === 0 ? { status: 'read', content: blob.stdout } : unusable('could not be read from the head commit');
}

/** Keeps the leading hunks of a patch that fit the limit. */
function fitHunks(patch: string, maxBytes: number): string {
  let kept = '';
  let bytes = 0;
  for (const hunk of patch.split(/^(?=@@ )/m)) {
    bytes += Buffer.byteLength(hunk);
    if (bytes > maxBytes) break;
    kept += hunk;
  }
  return kept;
}

/** States what changed in a resolved range. Selection and limits apply in path order. */
export function ingestCommittedRange(range: ResolvedRange, selection: Partial<RangeSelection> = {}): CommittedRangeOutcome {
  const { root, base, mergeBase, head } = range;
  const limits = { ...DEFAULT_RANGE_LIMITS, ...selection };
  const selected = pathSelector(selection.include ?? ['**'], selection.exclude ?? []);

  const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];
  const raw = git(root, ['diff', '--raw', '-z', ...diffFlags, mergeBase, head, '--']);
  if (raw.status !== 0) return failure('git-error', 'Git could not list the changed files.');
  const entries = parseRaw(raw.stdout);

  const files: RangeFile[] = [];
  const exclusions: RangeExclusion[] = [];
  let considered = 0;
  let totalBytes = 0;
  const exclude = (path: string, reason: ExclusionReason) => exclusions.push({ path, reason });

  entries.forEach((entry) => {
    if (!selected(entry.path)) return exclude(entry.path, 'ignored');
    const position = considered++;
    if (entry.status === 'deleted') return exclude(entry.path, 'deleted');
    if (!CODE_FILE.test(entry.path)) return exclude(entry.path, 'unsupported');
    if (position >= limits.maxChangedFiles) return exclude(entry.path, 'file-limit');

    const paths = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
    const diff = git(root, ['diff', `--unified=${RANGE_CONTEXT_LINES}`, ...diffFlags, mergeBase, head, '--', ...paths]);
    if (diff.status !== 0) return exclude(entry.path, 'unreadable');
    if (/^Binary files /m.test(diff.stdout) || /^GIT binary patch/m.test(diff.stdout)) return exclude(entry.path, 'binary');

    const start = diff.stdout.search(/^@@ /m);
    const full = start === -1 ? '' : diff.stdout.slice(start);
    if (parseChangedLines(full).length === 0) return exclude(entry.path, 'no-line-changes');

    const patch = fitHunks(full, limits.maxFileBytes);
    const changedLines = parseChangedLines(patch);
    if (changedLines.length === 0) return exclude(entry.path, 'oversized');
    const bytes = Buffer.byteLength(patch);
    if (totalBytes + bytes > limits.maxTotalBytes) return exclude(entry.path, 'total-limit');
    totalBytes += bytes;
    files.push({ path: entry.path, oldPath: entry.oldPath, status: entry.status, changedLines, patch });
    if (patch.length < full.length) exclude(entry.path, 'truncated');
  });

  const byReason = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number>;
  for (const { reason } of exclusions) byReason[reason]++;

  return {
    ok: true,
    base,
    mergeBase,
    head,
    files,
    exclusions,
    coverage: {
      changedFiles: entries.length,
      analyzedFiles: files.length,
      skippedFiles: exclusions.length - byReason.truncated,
      truncatedFiles: byReason.truncated,
      complete: !COVERAGE_BREAKING.some((reason) => byReason[reason] > 0),
      byReason,
    },
  };
}
