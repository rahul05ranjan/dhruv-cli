import { loadConfig } from '../config/config.js';
import { ask, AIError, AIRequest } from '../core/ai.js';
import { describeAIError } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { securityManager } from '../core/security.js';
import { ingestCommittedRange, type CommittedRangeLimits, type RangeFile } from '../core/committed-range.js';
import { presentCheckResult, type CheckRefs, type CheckResult } from '../core/check-presentation.js';

export interface CheckOptions {
  base?: string;
}

/** Seams for tests and later policy support. */
export interface CheckDeps {
  cwd?: string;
  limits?: Partial<CommittedRangeLimits>;
}

function formatRanges(file: RangeFile): string {
  return file.changedLines
    .flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
    .join(', ');
}

/** Renders a patch with new-side line numbers so the model can cite changed lines. */
function numberPatch(patch: string): string {
  const out: string[] = [];
  let line = 0;
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (header) {
      line = Number(header[1]);
      out.push(text);
    } else if (text.startsWith('+')) {
      out.push(`+${String(line++).padStart(5)}: ${text.slice(1)}`);
    } else if (text.startsWith(' ')) {
      out.push(` ${String(line++).padStart(5)}: ${text.slice(1)}`);
    } else if (text.startsWith('-')) {
      out.push(`-       : ${text.slice(1)}`);
    }
  }
  return out.join('\n');
}

function buildPrompt(files: RangeFile[]): string {
  const sections = files.map((file) => {
    const renamed = file.oldPath ? ` (renamed from ${file.oldPath})` : '';
    return `FILE ${file.path}${renamed} - changed lines: ${formatRanges(file)}\n${numberPatch(file.patch)}`;
  });
  return `Please review this committed change. Only the lines marked with + are new; the rest is context. Report concrete problems in the changed lines only, each with the file, line number, severity, a short explanation and an actionable recommendation. If you find nothing worth reporting, say so plainly.\n\nCODE_START\n${sections.join('\n\n')}\nCODE_END`;
}

/** Races the AI request against the timeout and Ctrl-C; always cleans up its timer and listener. */
async function askWithDeadline(request: AIRequest, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onSigint: (() => void) | undefined;
  try {
    const cancelled = new Promise<string>((_, reject) => {
      onSigint = () => {
        controller.abort();
        reject({ kind: 'cancelled' } satisfies AIError);
      };
      process.once('SIGINT', onSigint);
    });
    const contenders = [Promise.resolve(ask({ ...request, signal: controller.signal })), cancelled];
    if (timeoutMs > 0) {
      contenders.push(new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject({ kind: 'timeout', timeoutMs } satisfies AIError);
        }, timeoutMs);
      }));
    }
    return await Promise.race(contenders);
  } finally {
    if (timer) clearTimeout(timer);
    if (onSigint) process.removeListener('SIGINT', onSigint);
  }
}

function aiFailure(error: unknown, model: string, refs: CheckRefs): CheckResult {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as AIError).kind) : 'request';
  const hint = describeAIError(error, model).replace(/^💡 /, '');
  const timedOut = kind === 'timeout';
  return {
    status: kind === 'cancelled' ? 'cancelled' : 'error',
    refs,
    model,
    error: {
      kind: `ai-${kind}`,
      message: kind === 'cancelled' ? 'Review cancelled.' : timedOut ? 'The AI review timed out.' : 'The AI review failed.',
      hint,
    },
  };
}

/** Reviews committed changes from the merge base of `--base` and HEAD. Advisory: findings never fail the run. */
export async function check(options: CheckOptions = {}, deps: CheckDeps = {}): Promise<void> {
  try {
    presentCheckResult(await runCheck(options, deps));
  } catch (error) {
    presentCheckResult({
      status: 'error',
      error: { kind: 'internal', message: `check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}` },
    });
  }
}

async function runCheck(options: CheckOptions, deps: CheckDeps): Promise<CheckResult> {
  if (!options.base) {
    return { status: 'error', error: { kind: 'invalid-input', message: 'Missing required option --base <git-ref>.', hint: 'Example: dhruv check --base origin/main' } };
  }

  const range = ingestCommittedRange({ base: options.base, cwd: deps.cwd ?? process.cwd(), limits: deps.limits });
  if (!range.ok) return { status: 'error', error: { kind: range.reason, message: range.message } };

  const refs: CheckRefs = { base: range.base, mergeBase: range.mergeBase, head: range.head };
  const config = loadConfig();
  const summary = { refs, model: config.model, coverage: range.coverage, skipped: range.skipped };
  if (range.files.length === 0) return { status: 'ok', ...summary };

  // The allowlist gates AI access. Validate the resolved commit IDs, never the free-form ref.
  const validation = securityManager.validateInput('check', { base: range.base.commit, head: range.head });
  if (!validation.valid) {
    return { status: 'error', refs, error: { kind: 'validation', message: validation.error ?? 'Input validation failed.' } };
  }

  try {
    const response = await askWithDeadline({
      prompt: buildPrompt(range.files),
      systemMessage: getSystemMessage('review'),
      model: config.model,
    }, config.timeoutMs);
    if (!response.trim()) throw { kind: 'empty-response', model: config.model } satisfies AIError;
    return { status: 'ok', ...summary, review: response };
  } catch (error) {
    return aiFailure(error, config.model, refs);
  }
}
