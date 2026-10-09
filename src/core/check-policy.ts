/**
 * The project policy of `check`: one checked-in file that fixes what a review
 * covers, so every contributor and CI job reviews the same scope.
 *
 * The policy is `.dhruv-check.json` at the repository root, read from the `HEAD`
 * commit like the rest of the reviewed range: an uncommitted edit never takes
 * part. It is parsed as JSON data and nothing else, and must be a regular file of
 * at most 64 KiB. Without the file these defaults apply:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "include": ["**"],
 *   "exclude": [],
 *   "maxChangedFiles": 50,
 *   "maxFileBytes": 65536,
 *   "maxTotalBytes": 262144,
 *   "minSeverity": "info"
 * }
 * ```
 *
 * - `schemaVersion` (required): `1`. Every other key is optional.
 * - `include`, `exclude`: globs over repository-relative paths (syntax in
 *   `path-glob.ts`). A changed file is in scope when an include glob matches it
 *   and no exclude glob does; the rest is reported as `ignored`.
 * - `maxChangedFiles` (1 to 10000): changed files in scope beyond this count, in
 *   path order, are not analyzed.
 * - `maxFileBytes` (1 to 16777216): bytes of one file's patch (changed hunks with
 *   their context) sent to the model. A larger patch is truncated at a hunk boundary.
 * - `maxTotalBytes` (1 to 16777216): patch bytes sent in total. A file that no
 *   longer fits is skipped; later, smaller files may still fit.
 * - `minSeverity` (a `CHECK_SEVERITIES` value): less severe findings are counted
 *   but not shown.
 *
 * Unknown keys, wrong types and out-of-range values are errors, never ignored.
 * Each setting has a command-line option of the same name (`--max-changed-files`
 * for `maxChangedFiles`) that replaces the policy value for one run.
 */
import Joi from 'joi';
import { CHECK_SEVERITIES, type CheckSeverity } from './check-findings.js';
import { DEFAULT_RANGE_LIMITS, type CommittedRangeLimits } from './committed-range.js';
import { globProblem } from './path-glob.js';

export const CHECK_POLICY_FILE = '.dhruv-check.json';
export const CHECK_POLICY_SCHEMA_VERSION = 1;
export const MAX_POLICY_BYTES = 64 * 1024;

const MAX_GLOBS = 256;
const MAX_CHANGED_FILES = 10_000;
const MAX_PATCH_BYTES = 16 * 1024 * 1024;

export interface CheckPolicy extends CommittedRangeLimits {
  include: string[];
  exclude: string[];
  minSeverity: CheckSeverity;
}

export const DEFAULT_CHECK_POLICY: CheckPolicy = {
  include: ['**'],
  exclude: [],
  ...DEFAULT_RANGE_LIMITS,
  minSeverity: 'info',
};

/** Settings in the order they are reported. */
const SETTINGS = ['include', 'exclude', 'maxChangedFiles', 'maxFileBytes', 'maxTotalBytes', 'minSeverity'] as const;

export type CheckPolicySetting = (typeof SETTINGS)[number];

/** Command-line values as Commander hands them over: strings, or lists for the globs. */
export type CheckPolicyOverrides = Partial<Record<CheckPolicySetting, unknown>>;

/** The policy a run used and where each part came from. Carries no source text. */
export interface EffectiveCheckPolicy extends CheckPolicy {
  /** The policy file that was read, or `null` when the defaults applied. */
  file: string | null;
  schemaVersion: typeof CHECK_POLICY_SCHEMA_VERSION;
  /** Settings replaced on the command line for this run. */
  overrides: CheckPolicySetting[];
}

export type CheckPolicyOutcome =
  | { ok: true; policy: EffectiveCheckPolicy }
  | { ok: false; source: 'file' | 'options'; problems: string[] };

const glob = Joi.string().custom((value: string, helpers) => {
  const problem = globProblem(value);
  return problem ? helpers.message({ custom: `{{#label}} pattern "{{#value}}" ${problem}` }) : value;
}).messages({ 'string.base': '{{#label}} patterns must be strings', 'string.empty': '{{#label}} pattern must not be empty' });

function settingsSchema(label: (setting: CheckPolicySetting) => string): Record<CheckPolicySetting, Joi.Schema> {
  const limit = (max: number) => {
    const message = `{{#label}} must be a whole number from 1 to ${max}`;
    return Joi.number().integer().min(1).max(max)
      .messages({ 'number.base': message, 'number.integer': message, 'number.min': message, 'number.max': message });
  };
  const globs = (setting: CheckPolicySetting) => Joi.array().items(glob.label(label(setting))).max(MAX_GLOBS)
    .messages({ 'array.base': '{{#label}} must be a list of patterns', 'array.min': '{{#label}} must list at least one pattern' });
  const schemas: Record<CheckPolicySetting, Joi.Schema> = {
    include: globs('include').min(1),
    exclude: globs('exclude'),
    maxChangedFiles: limit(MAX_CHANGED_FILES),
    maxFileBytes: limit(MAX_PATCH_BYTES),
    maxTotalBytes: limit(MAX_PATCH_BYTES),
    minSeverity: Joi.string().valid(...CHECK_SEVERITIES),
  };
  for (const setting of SETTINGS) schemas[setting] = schemas[setting].label(label(setting));
  return schemas;
}

const fileSchema = Joi.object({
  schemaVersion: Joi.number().valid(CHECK_POLICY_SCHEMA_VERSION).required()
    .messages({ 'any.only': `{{#label}} must be ${CHECK_POLICY_SCHEMA_VERSION}, the only version this Dhruv supports` }),
  ...settingsSchema((setting) => setting),
});

function optionFlag(setting: CheckPolicySetting): string {
  return `--${setting.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

const optionsSchema = Joi.object(settingsSchema(optionFlag));

const MAX_PROBLEMS = 10;
const MAX_PROBLEM_LENGTH = 300;

/** Problems quote keys and values from the reviewed repository, so they are made safe to print. */
function printable(problems: string[]): string[] {
  const shown = problems.slice(0, MAX_PROBLEMS).map((problem) => problem.replace(/[\p{Cc}\s]+/gu, ' ').slice(0, MAX_PROBLEM_LENGTH));
  return problems.length > MAX_PROBLEMS ? [...shown, `and ${problems.length - MAX_PROBLEMS} more`] : shown;
}

function validate(schema: Joi.ObjectSchema, value: unknown, quoteLabels: boolean): { value: Partial<CheckPolicy>; problems: string[] } {
  const result = schema.validate(value, { abortEarly: false, convert: false, errors: { wrap: { label: quoteLabels ? '"' : false } } });
  return { value: result.value as Partial<CheckPolicy>, problems: printable(result.error?.details.map((detail) => detail.message) ?? []) };
}

function readFile(text: string): { value: Partial<CheckPolicy>; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: {}, problems: ['the file is not valid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: {}, problems: ['the file must be a JSON object'] };
  }
  return validate(fileSchema, parsed, true);
}

/** Turns command-line strings into the types the policy uses; anything else is left for validation to reject. */
function readOverrides(overrides: CheckPolicyOverrides): Partial<Record<CheckPolicySetting, unknown>> {
  const values: Partial<Record<CheckPolicySetting, unknown>> = {};
  for (const setting of SETTINGS) {
    const value = overrides[setting];
    if (value === undefined) continue;
    if (setting === 'include' || setting === 'exclude') values[setting] = typeof value === 'string' ? [value] : value;
    else if (setting === 'minSeverity') values[setting] = value;
    else values[setting] = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  }
  return values;
}

/**
 * Layers the defaults, the checked-in policy file (when there is one) and the
 * command-line overrides. Neither source is ever rewritten.
 */
export function resolveCheckPolicy(fileText: string | undefined, overrides: CheckPolicyOverrides = {}): CheckPolicyOutcome {
  const fromOptions = validate(optionsSchema, readOverrides(overrides), false);
  if (fromOptions.problems.length > 0) return { ok: false, source: 'options', problems: fromOptions.problems };

  const fromFile = fileText === undefined ? { value: {}, problems: [] } : readFile(fileText);
  if (fromFile.problems.length > 0) return { ok: false, source: 'file', problems: fromFile.problems };

  const merged = { ...DEFAULT_CHECK_POLICY, ...fromFile.value, ...fromOptions.value };
  return {
    ok: true,
    policy: {
      file: fileText === undefined ? null : CHECK_POLICY_FILE,
      schemaVersion: CHECK_POLICY_SCHEMA_VERSION,
      include: merged.include,
      exclude: merged.exclude,
      maxChangedFiles: merged.maxChangedFiles,
      maxFileBytes: merged.maxFileBytes,
      maxTotalBytes: merged.maxTotalBytes,
      minSeverity: merged.minSeverity,
      overrides: SETTINGS.filter((setting) => fromOptions.value[setting] !== undefined),
    },
  };
}
