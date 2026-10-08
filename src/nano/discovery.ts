import { execFileSync } from 'node:child_process';
import { lstatSync, opendirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import path from 'node:path';

export interface NanoWorkspace {
  root: string;
  scope: string;
  git: boolean;
}

export interface DiscoveryOptions {
  maxFiles?: number;
  maxEntries?: number;
}

export interface NanoDiscovery {
  paths: string[];
  partial: boolean;
  warnings: string[];
  permitted: (relative: string) => boolean;
}

const DEFAULT_MAX_FILES = 10000;
const DEFAULT_MAX_ENTRIES = 100000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WARNINGS = 8;
const EXCLUDED_PARTS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', 'out', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '.dhruv-cache', '.nano', 'logs',
]);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|(?:credentials?|secrets?|private[_-]?key)(?:[._-].*)?)$|\.(?:pem|key|p12|pfx|keystore|secrets?)$/i;

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function gitRoot(cwd: string): string | undefined {
  try {
    return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim());
  } catch {
    return undefined;
  }
}

function hasGitMarker(cwd: string): boolean {
  let current = cwd;
  for (;;) {
    try { lstatSync(path.join(current, '.git')); return true; } catch { /* continue to parent */ }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function canonicalDirectory(candidate: string, label: string): string {
  try {
    const canonical = realpathSync(candidate);
    if (!lstatSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new Error(`${label} must be an accessible directory.`);
  }
}

/** Resolve both bounds before any discovery. A scope cannot use traversal or a symlink component. */
export function resolveWorkspace(request: { cwd?: string; root?: string; scope?: string }): NanoWorkspace {
  const cwd = canonicalDirectory(request.cwd ?? process.cwd(), 'Current directory');
  const containingGitRoot = request.root ? undefined : gitRoot(cwd);
  if (!request.root && !containingGitRoot && hasGitMarker(cwd)) throw new Error('Git root discovery failed.');
  const root = canonicalDirectory(request.root ? path.resolve(cwd, request.root) : (containingGitRoot ?? cwd), 'Workspace root');
  const selectedGitRoot = gitRoot(root);
  if (!selectedGitRoot && hasGitMarker(root)) throw new Error('Git root discovery failed.');
  const git = selectedGitRoot === root;
  let scope = root;
  if (request.scope) {
    if (request.scope.split(/[\\/]/).includes('..')) throw new Error('Scope must be inside the workspace root.');
    const requested = path.resolve(root, request.scope);
    if (!within(root, requested)) throw new Error('Scope must be inside the workspace root.');
    // Reject symlinks in every path component, including a symlink to an in-root directory.
    let current = root;
    for (const part of path.relative(root, requested).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('symlink');
      } catch {
        throw new Error('Scope must be an accessible directory without symlinks.');
      }
    }
    scope = canonicalDirectory(requested, 'Scope');
    if (!within(root, scope)) throw new Error('Scope must be inside the workspace root.');
  }
  return { root, scope, git };
}

function gitFiles(root: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(output.split('\0').filter(Boolean))].sort();
  } catch {
    throw new Error('Git discovery failed or exceeded its output limit.');
  }
}

function gitIgnored(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const output = execFileSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: root, input: `${paths.join('\0')}\0`, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(output.split('\0').filter(Boolean));
  } catch (error) {
    // git check-ignore exits 1 when no path matches.
    const result = error as { status?: number; stdout?: string };
    if (result.status === 1) return new Set();
    throw new Error('Git ignore evaluation failed or exceeded its output limit.', { cause: error });
  }
}

interface IgnoreRule { base: string; regex: RegExp; negated: boolean; directory: boolean }

function globRegex(pattern: string, anchored: boolean): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index++; }
      else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(^|/)'}${source}$`);
}

function loadNanoRules(root: string, relativeDir: string): IgnoreRule[] {
  let current = root;
  try {
    for (const part of relativeDir.split(/[\\/]/).filter(Boolean)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('unsafe Nano ignore directory');
    }
    const filename = path.join(current, '.nanoignore');
    const stat = lstatSync(filename);
    if (!within(root, filename) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || realpathSync(filename) !== filename) throw new Error('unsafe Nano ignore file');
    const lines = readFileSync(filename, 'utf8').split(/\r?\n/);
    if (lines.length > 1024) throw new Error('too many Nano ignore rules');
    return lines.flatMap((line) => {
      const value = line.trim();
      if (!value || value.startsWith('#')) return [];
      const negated = value.startsWith('!');
      const raw = negated ? value.slice(1) : value;
      const directory = raw.endsWith('/');
      const pattern = raw.replace(/^\//, '').replace(/\/$/, '');
      if (!pattern || pattern.split('/').includes('..')) return [];
      if (pattern.length > 256) throw new Error('Nano ignore rule too long');
      return [{ base: relativeDir.split(path.sep).join('/'), regex: globRegex(pattern, raw.startsWith('/') || pattern.includes('/')), negated, directory }];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Nano ignore rules could not be read.', { cause: error });
  }
}

function nanoIgnored(relative: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const local = rule.base ? relative.startsWith(`${rule.base}/`) ? relative.slice(rule.base.length + 1) : '' : relative;
    if (!local) continue;
    const parts = local.split('/');
    const candidates = rule.directory ? parts.slice(0, isDirectory ? parts.length : -1).map((_, index) => parts.slice(0, index + 1).join('/')) : [local];
    if (candidates.some((candidate) => rule.regex.test(candidate))) ignored = !rule.negated;
  }
  return ignored;
}

function excluded(relative: string): boolean {
  const parts = relative.split('/');
  return parts.some((part) => EXCLUDED_PARTS.has(part) || SENSITIVE_NAME.test(part));
}

/** Recheck immediately before reading any candidate. This also rejects symlinked parent components. */
export function safeFile(workspace: NanoWorkspace, relative: string): string | undefined {
  if (!relative || excluded(relative.split(path.sep).join('/')) || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..' || part === '.')) return undefined;
  const absolute = path.resolve(workspace.root, relative);
  if (!within(workspace.scope, absolute) || !within(workspace.root, absolute)) return undefined;
  let current = workspace.root;
  try {
    for (const part of path.relative(workspace.root, absolute).split(path.sep)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) return undefined;
    }
    if (!lstatSync(absolute).isFile()) return undefined;
    if (realpathSync(absolute) !== absolute) return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

/** Lists only permitted on-disk files; warnings are deliberately bounded and path-free. */
export function discoverFiles(workspace: NanoWorkspace, options: DiscoveryOptions = {}): NanoDiscovery {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Discovery limits must be positive integers.');
  const warnings: string[] = [];
  let partial = false;
  const warn = (message: string): void => { if (!warnings.includes(message) && warnings.length < MAX_WARNINGS) warnings.push(message); };
  const rules = loadNanoRules(workspace.root, '');
  const seenRules = new Set(['']);
  const rulesFor = (relative: string): IgnoreRule[] => {
    const dirs = relative.split('/').slice(0, -1);
    let current = '';
    for (const dir of dirs) {
      current = current ? `${current}/${dir}` : dir;
      if (!seenRules.has(current) && !excluded(current)) {
        rules.push(...loadNanoRules(workspace.root, current));
        seenRules.add(current);
      }
    }
    return rules;
  };
  const permitted = (relative: string): boolean => !excluded(relative) && !nanoIgnored(relative, false, rulesFor(relative));
  const paths: string[] = [];
  let entries = 0;
  if (workspace.git) {
    const found = gitFiles(workspace.root);
    const ignored = gitIgnored(workspace.root, found);
    for (const relative of found) {
      if (++entries > maxEntries) { partial = true; warn('Discovery entry limit reached.'); break; }
      const slash = relative.split(path.sep).join('/');
      if (!within(workspace.scope, path.resolve(workspace.root, relative)) || ignored.has(relative) || excluded(slash)) continue;
      if (!safeFile(workspace, relative)) { partial = true; warn('Some listed files were inaccessible or symlinked.'); continue; }
      if (!permitted(slash)) continue;
      if (paths.length >= maxFiles) { partial = true; warn('Discovery file limit reached.'); break; }
      paths.push(slash);
    }
  } else {
    const stack = [path.relative(workspace.root, workspace.scope)];
    while (stack.length) {
      const directory = stack.pop() ?? '';
      const directoryEntries: Dirent[] = [];
      try {
        const handle = opendirSync(path.join(workspace.root, directory));
        try {
          let entry: Dirent | null;
          while ((entry = handle.readSync()) !== null) {
            if (entries + directoryEntries.length >= maxEntries) {
              partial = true; warn('Discovery entry limit reached.'); stack.length = 0; break;
            }
            directoryEntries.push(entry);
          }
        } finally {
          handle.closeSync();
        }
        directoryEntries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      } catch {
        partial = true; warn('Some directories were unreadable.'); continue;
      }
      for (const entry of directoryEntries) {
        entries++;
        const relative = path.join(directory, entry.name).split(path.sep).join('/');
        if (excluded(relative)) continue;
        if (entry.isSymbolicLink()) { partial = true; warn('Some entries were symlinked and skipped.'); continue; }
        if (entry.isDirectory()) {
          if (!nanoIgnored(relative, true, rulesFor(`${relative}/child`))) stack.push(relative);
        } else if (entry.isFile() && permitted(relative)) {
          if (!safeFile(workspace, relative)) { partial = true; warn('Some files were unreadable.'); continue; }
          if (paths.length >= maxFiles) { partial = true; warn('Discovery file limit reached.'); stack.length = 0; break; }
          paths.push(relative);
        }
      }
    }
  }
  paths.sort();
  return { paths, partial, warnings, permitted };
}
