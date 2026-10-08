import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverFiles, resolveWorkspace, safeFile } from './discovery.js';
import { hasCurrentDeclaration, parseSource, sourceFingerprint, type NanoSymbolDeclaration } from './symbols.js';

export interface NanoLexicalEvidence {
  kind: 'path' | 'text';
  basis: 'lexical';
  detail: string;
  line?: number;
}

export interface NanoSymbolEvidence extends NanoSymbolDeclaration {
  kind: 'symbol';
  basis: 'syntax';
  detail: string;
  line: number;
  verified: true;
  fingerprint: string;
}

export type NanoEvidence = NanoLexicalEvidence | NanoSymbolEvidence;

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

function taskNamesSymbol(task: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_$])${escaped}(?=$|[^\\p{L}\\p{N}_$])`, 'u').test(task);
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
  const files: (NanoFile & { tier: number; fingerprint: string })[] = [];

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
      const parsed = parseSource(slashPath, source);
      if (parsed.partial) {
        partial = true;
        if (!warnings.includes('Some TypeScript or JavaScript files have syntax errors; declaration evidence is partial.')) {
          warnings.push('Some TypeScript or JavaScript files have syntax errors; declaration evidence is partial.');
        }
      }
      const lowerPath = slashPath.toLowerCase();
      const basename = path.basename(relative).toLowerCase();
      const explicit = (lowerPath.includes('/') && normalizedTask.includes(lowerPath)) ||
        (basename.includes('.') && normalizedTask.includes(basename));
      let score = explicit ? 1000 : 0;
      const evidence: NanoEvidence[] = [];
      if (explicit) evidence.push({ kind: 'path', basis: 'lexical', detail: 'Task names this on-disk path.' });
      let explicitSymbol = false;
      for (const declaration of parsed.symbols) {
        if (!taskNamesSymbol(request.task, declaration.symbol)) continue;
        explicitSymbol = true;
        score += 100;
        evidence.push({
          ...declaration,
          kind: 'symbol', basis: 'syntax', verified: true,
          detail: `Parsed ${declaration.declarationKind} declaration for ${declaration.symbol}.`,
          line: declaration.startLine,
          fingerprint: parsed.fingerprint,
        });
      }
      for (const term of terms) {
        if (lowerPath.includes(term)) {
          score += 12;
          evidence.push({ kind: 'path', basis: 'lexical', detail: `Path contains ${term}.` });
        } else {
          const line = matchingLine(source, term);
          if (line !== undefined) {
            score += 1;
            evidence.push({ kind: 'text', basis: 'lexical', detail: `Text contains ${term}.`, line });
          }
        }
      }
      if (score > 0) {
        if (parsed.language === 'unsupported' && !warnings.includes('Some matched files use unsupported languages; path and text evidence only.')) {
          warnings.push('Some matched files use unsupported languages; path and text evidence only.');
        }
        files.push({ path: slashPath, score, evidence, tier: explicit ? 2 : explicitSymbol ? 1 : 0, fingerprint: parsed.fingerprint });
      }
    } catch {
      partial = true;
    }
  }

  files.sort((a, b) => b.tier - a.tier || b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const currentFiles: NanoFile[] = [];
  for (const file of files) {
    if (currentFiles.length >= top) break;
    try {
      const absolute = safeFile(workspace, file.path);
      if (!absolute) throw new Error('Source changed during verification.');
      if (lstatSync(absolute).size > MAX_SOURCE_BYTES) throw new Error('Source grew beyond the scan limit.');
      const currentSource = readFileSync(absolute, 'utf8');
      if (sourceFingerprint(currentSource) !== file.fingerprint) throw new Error('Source changed during verification.');
      const current = parseSource(file.path, currentSource);
      if (file.evidence.some((item) => item.kind === 'symbol' && !hasCurrentDeclaration(current, item.fingerprint, item))) {
        throw new Error('Declaration changed during verification.');
      }
      currentFiles.push({ path: file.path, score: file.score, evidence: file.evidence });
    } catch {
      partial = true;
      if (!warnings.includes('Some source locations changed before final verification.')) warnings.push('Some source locations changed before final verification.');
    }
  }
  if (partial) warnings.push('Coverage is partial: some files could not be scanned.');
  if (currentFiles.length === 0) warnings.push('No supported file match was found for this task.');
  return {
    schemaVersion: 1,
    command: 'nano context',
    root,
    files: currentFiles,
    coverage: { discovered: discovered.paths.length, scanned, partial },
    truncated: files.length > currentFiles.length,
    warnings,
  };
}
