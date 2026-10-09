import { loadConfig } from '../config/config.js';
import { ask, AIError, AIRequest } from '../core/ai.js';
import { describeAIError } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { securityManager } from '../core/security.js';
import { ingestCommittedRange, readCommittedFile, resolveCommittedRange } from '../core/committed-range.js';
import { readFindings, summarizeFindings } from '../core/check-findings.js';
import { buildCheckPrompt } from '../core/check-prompt.js';
import { CHECK_POLICY_FILE, MAX_POLICY_BYTES, resolveCheckPolicy, type CheckPolicyOverrides } from '../core/check-policy.js';
import { presentCheckResult, type CheckRangeFacts, type CheckResult } from '../core/check-presentation.js';

/** Options as Commander parses them. The policy settings override the checked-in policy for this run only. */
export interface CheckOptions extends CheckPolicyOverrides {
  base?: string;
  /** Turns incomplete coverage into its own failing outcome. */
  strictCoverage?: boolean;
}

/** Seams for tests. */
export interface CheckDeps {
  cwd?: string;
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

function aiFailure(error: unknown, facts: CheckRangeFacts): CheckResult {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as AIError).kind) : 'request';
  const hint = describeAIError(error, facts.model).replace(/^💡 /, '');
  const timedOut = kind === 'timeout';
  return {
    status: kind === 'cancelled' ? 'cancelled' : 'error',
    ...facts,
    error: {
      kind: `ai-${kind}`,
      message: kind === 'cancelled' ? 'Review cancelled.' : timedOut ? 'The AI review timed out.' : 'The AI review failed.',
      hint,
    },
  };
}

function invalidPolicy(problems: string[], sourceCommit: string): CheckResult {
  return {
    status: 'error',
    error: {
      kind: 'invalid-policy',
      message: `Invalid policy ${CHECK_POLICY_FILE}: ${problems.join('; ')}.`,
      hint: `Fix ${CHECK_POLICY_FILE} on the base branch (commit ${sourceCommit}).`,
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

  const resolved = resolveCommittedRange({ base: options.base, cwd: deps.cwd ?? process.cwd() });
  if (!resolved.ok) return { status: 'error', error: { kind: resolved.reason, message: resolved.message } };

  // The base commit is the trusted policy source for a PR comparison.
  const policyFile = readCommittedFile(resolved, CHECK_POLICY_FILE, MAX_POLICY_BYTES, resolved.base.commit);
  if (policyFile.status === 'unusable') return invalidPolicy([`the file ${policyFile.problem}`], resolved.base.commit);
  const resolution = resolveCheckPolicy(policyFile.status === 'read' ? policyFile.content : undefined, options, resolved.base.commit);
  if (!resolution.ok) {
    if (resolution.source === 'file') return invalidPolicy(resolution.problems, resolved.base.commit);
    return { status: 'error', error: { kind: 'invalid-input', message: `Invalid option: ${resolution.problems.join('; ')}.`, hint: 'Run: dhruv check --help' } };
  }
  const { policy } = resolution;

  const range = ingestCommittedRange(resolved, policy);
  if (!range.ok) return { status: 'error', error: { kind: range.reason, message: range.message } };

  const config = loadConfig();
  const facts: CheckRangeFacts = {
    refs: { base: range.base, mergeBase: range.mergeBase, head: range.head },
    model: config.model,
    policy,
    coverage: range.coverage,
    exclusions: range.exclusions,
  };
  // Zero findings never stands in for coverage: strict coverage fails on what went unreviewed.
  const status = options.strictCoverage && !range.coverage.complete ? 'incomplete' : 'ok';
  if (range.files.length === 0) return { status, ...facts, summary: summarizeFindings([]), findings: [] };

  // The allowlist gates AI access. Validate the resolved commit IDs, never the free-form ref.
  const validation = securityManager.validateInput('check', { base: range.base.commit, head: range.head });
  if (!validation.valid) {
    return { status: 'error', ...facts, error: { kind: 'validation', message: validation.error ?? 'Input validation failed.' } };
  }

  let response: string;
  try {
    // The response cache would leave model output in the checkout and replay stale reviews.
    response = await askWithDeadline({
      prompt: buildCheckPrompt(range.files),
      systemMessage: getSystemMessage('check'),
      model: config.model,
      cache: false,
    }, config.timeoutMs);
    if (!response.trim()) throw { kind: 'empty-response', model: config.model } satisfies AIError;
  } catch (error) {
    return aiFailure(error, facts);
  }

  // The response itself is never echoed: an unusable one is reported by kind only.
  const outcome = readFindings(response, range.files, policy.minSeverity);
  if (!outcome.ok) {
    return {
      status: 'error',
      ...facts,
      error: { kind: 'invalid-response', message: outcome.message, hint: 'Run the check again, or choose a more capable model with --model.' },
    };
  }
  return { status, ...facts, summary: outcome.summary, findings: outcome.findings };
}
