import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverFiles, resolveWorkspace, safeFile } from './discovery.js';

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

const MAX_SOURCE_BYTES = 1024 * 1024;
const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'fix', 'add', 'find', 'file', 'files', 'where', 'which', 'how', 'please', 'src', 'ts', 'tsx', 'js', 'jsx']);

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
  const workspace = resolveWorkspace(request);
  const { root } = workspace;
  const top = request.top ?? 10;
  if (!Number.isInteger(top) || top < 1 || top > 30) throw new Error('Top must be an integer from 1 to 30.');

  const discovered = discoverFiles(workspace);
  const warnings: string[] = [...discovered.warnings];
  let scanned = 0;
  let partial = discovered.partial;
  const terms = taskTerms(request.task);
  const normalizedTask = request.task.toLowerCase().replace(/\\/g, '/');
  const files: (NanoFile & { explicit: boolean })[] = [];

  for (const relative of discovered.paths) {
    if (!discovered.permitted(relative)) continue;
    try {
      const absolute = safeFile(workspace, relative);
      if (!absolute) { partial = true; continue; }
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
