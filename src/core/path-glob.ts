/**
 * Glob matching for repository-relative POSIX paths, as used by the `check` policy.
 *
 * - `*` matches within one path segment, `?` one character of a segment, and a
 *   `**` segment any number of segments, including none.
 * - A pattern without `/` matches a name at any depth (`*.min.js`); one with `/`
 *   is anchored at the repository root (`src/api/*.ts`). A leading `/` only anchors.
 * - A pattern that matches a directory covers everything below it (`vendor`,
 *   `src/generated`); a trailing `/` matches directories only.
 * - Matching is case-sensitive. Negation, braces and character classes are not
 *   supported; all other characters match themselves.
 *
 * Patterns come from the reviewed repository, so matching never builds a regular
 * expression: a hostile pattern cannot cause catastrophic backtracking.
 */

export const MAX_GLOB_LENGTH = 256;

/** Says why a pattern cannot be used, or nothing when it can. */
export function globProblem(pattern: string): string | undefined {
  if (!pattern.trim()) return 'must not be empty';
  if (pattern.length > MAX_GLOB_LENGTH) return `must be at most ${MAX_GLOB_LENGTH} characters`;
  if (pattern.startsWith('!')) return 'must not start with "!" (negation is not supported; use include and exclude)';
  if (pattern.includes('\\')) return 'must use "/" as the path separator';
  if (pattern.split('/').includes('..')) return 'must not contain ".." segments';
  if (!pattern.replace(/^\/+|\/+$/g, '')) return 'must name a path';
  return undefined;
}

/** Wildcard match with a single backtrack point: `any` consumes a run, `same` compares one item. */
function wildcardMatch<P, T>(pattern: readonly P[], text: readonly T[], any: (item: P) => boolean, same: (item: P, value: T) => boolean): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && any(pattern[p])) {
      star = p++;
      mark = t;
    } else if (p < pattern.length && same(pattern[p], text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && any(pattern[p])) p++;
  return p === pattern.length;
}

function segmentMatches(pattern: string, name: string): boolean {
  return wildcardMatch([...pattern], [...name], (char) => char === '*', (char, value) => char === '?' || char === value);
}

/** Compiles one pattern into a test for repository-relative POSIX paths. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const trimmed = pattern.replace(/^\/+|\/+$/g, '');
  const anchored = pattern.startsWith('/') || trimmed.includes('/');
  // The closing `**` lets a pattern that matches a directory cover everything below it.
  const segments = [...(anchored ? [] : ['**']), ...trimmed.split('/'), ...(pattern.endsWith('/') ? ['*'] : []), '**'];
  return (path) => wildcardMatch(segments, path.split('/'), (segment) => segment === '**', segmentMatches);
}

/** A path is selected when an include pattern matches it and no exclude pattern does. */
export function pathSelector(include: readonly string[], exclude: readonly string[]): (path: string) => boolean {
  const included = include.map(globMatcher);
  const excluded = exclude.map(globMatcher);
  return (path) => included.some((matches) => matches(path)) && !excluded.some((matches) => matches(path));
}
