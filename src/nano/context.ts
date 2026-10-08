import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface NanoEvidence {
  kind: 'path' | 'text';
  detail: string;
  line?: number;
}

export interface NanoFile {
  path: string;
  score: number;
  evidence: NanoEvidence[];
}

export interface NanoContextResponse {
  schemaVersion: 1;
  command: 'nano context';
  root: string;
  files: NanoFile[];
  coverage: { discovered: number; scanned: number; partial: boolean };
  truncated: boolean;
  warnings: string[];
}

export interface NanoContextRequest {
  task: string;
  cwd?: string;
  root?: string;
  scope?: string;
  top?: number;
}

const MAX_FILES = 10000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'fix', 'add', 'find', 'file', 'files', 'where', 'which', 'how', 'please', 'src', 'ts', 'tsx', 'js', 'jsx']);
const EXCLUDED_PARTS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.dhruv-cache', 'logs']);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx)$/i;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function permitted(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return !parts.some((part) => EXCLUDED_PARTS.has(part) || SENSITIVE_NAME.test(part));
}

function gitRoot(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function discover(root: string, git: boolean): { paths: string[]; partial: boolean } {
  const paths: string[] = [];
  let partial = false;
  if (git) {
    try {
      const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const found = [...new Set(output.split('\0').filter(Boolean))].sort();
      return { paths: found.slice(0, MAX_FILES), partial: found.length > MAX_FILES };
    } catch {
      partial = true;
    }
  }

  // A bounded fallback supports directories without Git and unavailable Git.
  const stack = [''];
  while (stack.length && paths.length < MAX_FILES) {
    const directory = stack.pop() ?? '';
    let entries;
    try {
      entries = readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch {
      partial = true;
      continue;
    }
    for (const entry of entries) {
      const relative = path.join(directory, entry.name);
      if (!permitted(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(relative);
      else if (entry.isFile()) paths.push(relative);
      if (paths.length >= MAX_FILES) { partial = true; break; }
    }
  }
  return { paths: paths.sort(), partial };
}

function taskTerms(task: string): string[] {
  return [...new Set((task.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term)))];
}

function matchingLine(source: string, term: string): number | undefined {
  const index = source.toLowerCase().indexOf(term);
  if (index < 0) return undefined;
  return source.slice(0, index).split('\n').length;
}

export function context(request: NanoContextRequest): NanoContextResponse {
  if (!request.task.trim()) throw new Error('Task text is required.');
  const cwd = realpathSync(request.cwd ?? process.cwd());
  const containingGitRoot = gitRoot(cwd);
  const root = realpathSync(request.root ? path.resolve(cwd, request.root) : (containingGitRoot ?? cwd));
  const git = gitRoot(root) === root;
  const scope = request.scope ? path.resolve(root, request.scope) : root;
  if (!inside(root, scope)) throw new Error('Scope must be inside the workspace root.');
  if (request.scope && realpathSync(scope) !== scope) throw new Error('Scope must not be a symlink.');
  const top = request.top ?? 10;
  if (!Number.isInteger(top) || top < 1 || top > 30) throw new Error('Top must be an integer from 1 to 30.');

  const discovered = discover(root, git);
  const warnings: string[] = [];
  let scanned = 0;
  let partial = discovered.partial;
  const terms = taskTerms(request.task);
  const normalizedTask = request.task.toLowerCase().replace(/\\/g, '/');
  const files: (NanoFile & { explicit: boolean })[] = [];

  for (const relative of discovered.paths) {
    const absolute = path.resolve(root, relative);
    if (!inside(scope, absolute) || !permitted(relative)) continue;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > MAX_SOURCE_BYTES) { partial = true; continue; }
      const source = readFileSync(absolute, 'utf8');
      scanned++;
      const slashPath = relative.split(path.sep).join('/');
      const lowerPath = slashPath.toLowerCase();
      const basename = path.basename(relative).toLowerCase();
      const explicit = (lowerPath.includes('/') && normalizedTask.includes(lowerPath)) ||
        (basename.includes('.') && normalizedTask.includes(basename));
      let score = explicit ? 1000 : 0;
      const evidence: NanoEvidence[] = [];
      if (explicit) evidence.push({ kind: 'path', detail: 'Task names this on-disk path.' });
      for (const term of terms) {
        if (lowerPath.includes(term)) {
          score += 12;
          evidence.push({ kind: 'path', detail: `Path contains ${term}.` });
        } else {
          const line = matchingLine(source, term);
          if (line !== undefined) {
            score += 1;
            evidence.push({ kind: 'text', detail: `Text contains ${term}.`, line });
          }
        }
      }
      if (score > 0) files.push({ path: slashPath, score, evidence, explicit });
    } catch {
      partial = true;
    }
  }

  files.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (partial) warnings.push('Coverage is partial: some files could not be scanned.');
  if (files.length === 0) warnings.push('No supported file match was found for this task.');
  return {
    schemaVersion: 1,
    command: 'nano context',
    root,
    files: files.slice(0, top).map(({ path: filePath, score, evidence }) => ({ path: filePath, score, evidence })),
    coverage: { discovered: discovered.paths.length, scanned, partial },
    truncated: files.length > top,
    warnings,
  };
}
