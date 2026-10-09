import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkspace, safeFile } from './discovery.js';
import { refreshIndex } from './index.js';
import { buildRelationshipSuggestions, hasCurrentImport, isTestPath, parseLocalImports, type NanoImportEvidence, type NanoImportSite, type NanoRelatedTestEvidence } from './relationships.js';
import { hasCurrentDeclaration, parseSource, sourceFingerprint, type NanoSymbolDeclaration } from './symbols.js';

export interface NanoLexicalEvidence {
  kind: 'path' | 'text';
  basis: 'lexical';
  detail: string;
  line?: number;
  verified?: true;
}

export interface NanoSymbolEvidence extends NanoSymbolDeclaration {
  kind: 'symbol';
  basis: 'syntax';
  detail: string;
  line: number;
  verified: true;
  fingerprint: string;
}

export type NanoEvidence = NanoLexicalEvidence | NanoSymbolEvidence | NanoImportEvidence | NanoRelatedTestEvidence;

export interface NanoFile {
  path: string;
  /** A relative ordering signal, never a correctness probability. */
  rankingSignal: number;
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
  index: { identity: string | null; freshness: 'fresh' | 'partial' | 'missing' | 'stale' | 'corrupt' | 'purged'; reused: number };
}

export interface NanoContextRequest {
  task: string;
  cwd?: string;
  root?: string;
  scope?: string;
  top?: number;
  maxOutputBytes?: number;
  maxRefreshFiles?: number;
  maxRefreshBytes?: number;
  refresh?: boolean;
}

const MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const MIN_OUTPUT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_WARNING = 'Output byte limit reached; results or evidence were truncated.';
const WEAK_WARNING = 'Only weak lexical matches were found; read source to establish relevance.';
const EMPTY_COVERAGE_WARNING = 'Coverage found no matching evidence in the scanned files.';
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

function taskNamesPath(task: string, namedPath: string): boolean {
  let position = task.indexOf(namedPath);
  while (position !== -1) {
    const before = task.slice(0, position);
    const after = task.slice(position + namedPath.length);
    if (!/[\p{L}\p{N}_./-]$/u.test(before) && !/^[\p{L}\p{N}_./-]/u.test(after)) return true;
    position = task.indexOf(namedPath, position + 1);
  }
  return false;
}

function collectContext(request: NanoContextRequest): { response: NanoContextResponse; candidates: string[] } {
  if (!request.task.trim()) throw new Error('Task text is required.');
  const workspace = resolveWorkspace(request);
  const { root } = workspace;
  const top = request.top ?? 10;
  if (!Number.isInteger(top) || top < 1 || top > 30) throw new Error('Top must be an integer from 1 to 30.');
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < MIN_OUTPUT_BYTES || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Output byte limit must be an integer from ${MIN_OUTPUT_BYTES} to ${MAX_OUTPUT_BYTES}.`);
  }

  const refreshed = refreshIndex(workspace, { maxFiles: request.maxRefreshFiles, maxBytes: request.maxRefreshBytes, force: request.refresh });
  const warnings: string[] = [...refreshed.report.warnings];
  let partial = refreshed.report.coverage.partial;
  const terms = taskTerms(request.task);
  const normalizedTask = request.task.toLowerCase().replace(/\\/g, '/');
  const files: (NanoFile & { tier: number; fingerprint: string })[] = [];
  const importsByFile = new Map<string, ReturnType<typeof parseLocalImports>>();
  const scannedFingerprints = new Map<string, string>();

  for (const entry of refreshed.files) {
    const relative = entry.path;
    try {
      const source = entry.source;
      const slashPath = relative.split(path.sep).join('/');
      const parsed = entry.parsed;
      scannedFingerprints.set(slashPath, parsed.fingerprint);
      importsByFile.set(slashPath, parseLocalImports(slashPath, source));
      if (parsed.partial) {
        partial = true;
        if (!warnings.includes('Some TypeScript or JavaScript files have syntax errors; declaration evidence is partial.')) {
          warnings.push('Some TypeScript or JavaScript files have syntax errors; declaration evidence is partial.');
        }
      }
      const lowerPath = slashPath.toLowerCase();
      const basename = path.basename(relative).toLowerCase();
      const explicit = (lowerPath.includes('/') && taskNamesPath(normalizedTask, lowerPath)) ||
        (basename.includes('.') && taskNamesPath(normalizedTask, basename));
      let score = explicit ? 1000 : 0;
      const evidence: NanoEvidence[] = [];
      if (explicit) evidence.push({ kind: 'path', basis: 'lexical', verified: true, detail: 'Task names this on-disk path.' });
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
      // A similarly named test is not evidence of a relationship. An explicit
      // request for the test path can still find that file directly.
      if (score > 0 && (!isTestPath(slashPath) || explicit)) {
        if (parsed.language === 'unsupported' && !warnings.includes('Some matched files use unsupported languages; path and text evidence only.')) {
          warnings.push('Some matched files use unsupported languages; path and text evidence only.');
        }
        files.push({ path: slashPath, rankingSignal: score, evidence, tier: explicit ? 2 : explicitSymbol ? 1 : 0, fingerprint: parsed.fingerprint });
      }
    } catch {
      partial = true;
    }
  }

  const seeds = files.filter((file) => file.tier > 0 && !isTestPath(file.path)).map((file) => file.path);
  const relationships = buildRelationshipSuggestions(importsByFile, seeds);
  partial ||= relationships.partial;
  warnings.push(...relationships.warnings.filter((warning) => !warnings.includes(warning)));
  for (const suggestion of relationships.suggestions) {
    const existing = files.find((file) => file.path === suggestion.path);
    if (existing) {
      existing.rankingSignal += suggestion.score;
      existing.evidence.push(suggestion.evidence);
    } else {
      const fingerprint = scannedFingerprints.get(suggestion.path);
      if (fingerprint === undefined) continue;
      files.push({ path: suggestion.path, rankingSignal: suggestion.score, tier: 0,
        fingerprint, evidence: [suggestion.evidence] });
    }
  }

  files.sort((a, b) => b.tier - a.tier || b.rankingSignal - a.rankingSignal || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Diagnostic-only candidate set for offline evaluation. It is never added to
  // the bounded CLI response or persisted in the index.
  const candidates = files.map((file) => file.path);
  const onlyWeak = files.length > 0 && files.every((file) => file.tier === 0 &&
    file.evidence.every((item) => item.kind === 'path' || item.kind === 'text'));
  const resultLimit = onlyWeak ? Math.min(top, 3) : top;
  const currentFiles: NanoFile[] = [];
  for (const file of files) {
    if (currentFiles.length >= resultLimit) break;
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
      const currentSources = new Map<string, string>();
      const ensureCurrent = (relative: string): void => {
        if (currentSources.has(relative)) return;
        const target = safeFile(workspace, relative);
        if (!target || lstatSync(target).size > MAX_SOURCE_BYTES) throw new Error('Relationship endpoint changed during verification.');
        const value = readFileSync(target, 'utf8');
        if (sourceFingerprint(value) !== scannedFingerprints.get(relative)) throw new Error('Relationship endpoint changed during verification.');
        currentSources.set(relative, value);
      };
      for (const evidence of file.evidence) {
        const sites: NanoImportSite[] = evidence.kind === 'related-test' ? evidence.imports
          : evidence.kind === 'import' ? [{ importer: evidence.importer, imported: evidence.imported,
            specifier: evidence.specifier, kind: evidence.importKind, line: evidence.line, startOffset: evidence.startOffset }] : [];
        for (const site of sites) {
          ensureCurrent(site.importer);
          ensureCurrent(site.imported);
          if (!hasCurrentImport(site, currentSources, new Set(importsByFile.keys()))) throw new Error('Import changed during verification.');
        }
      }
      currentFiles.push({ path: file.path, rankingSignal: file.rankingSignal, evidence: file.evidence });
    } catch {
      partial = true;
      if (!warnings.includes('Some source locations changed before final verification.')) warnings.push('Some source locations changed before final verification.');
    }
  }
  if (partial) warnings.push('Coverage is partial: some files could not be scanned.');
  if (onlyWeak) warnings.push(WEAK_WARNING);
  if (currentFiles.length === 0) {
    warnings.push('No supported file match was found for this task.');
    warnings.push(EMPTY_COVERAGE_WARNING);
  }
  const response: NanoContextResponse = {
    schemaVersion: 1,
    command: 'nano context',
    root,
    files: currentFiles,
    coverage: { discovered: refreshed.report.coverage.discovered, scanned: refreshed.report.coverage.scanned, partial },
    truncated: files.length > currentFiles.length,
    warnings,
    index: { identity: refreshed.report.identity, freshness: partial ? 'partial' : refreshed.report.freshness, reused: refreshed.report.coverage.reused },
  };
  // Measure the serialized document, including evidence and metadata. Keep the
  // highest-ranked files and earliest evidence when the byte budget is tight.
  const size = (): number => Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (size() > maxOutputBytes) {
    response.truncated = true;
    response.warnings.push(OUTPUT_WARNING);
    while (size() > maxOutputBytes && response.files.length > 0) {
      const last = response.files[response.files.length - 1];
      if (last.evidence.length > 1) last.evidence.pop();
      else response.files.pop();
    }
    // Diagnostic warnings have bounded priority below the coverage and budget
    // warnings; preserve those even for a highly constrained valid response.
    const essential = new Set([OUTPUT_WARNING, WEAK_WARNING, EMPTY_COVERAGE_WARNING,
      'Coverage is partial: some files could not be scanned.',
      'No supported file match was found for this task.']);
    while (size() > maxOutputBytes) {
      const index = response.warnings.findIndex((warning) => !essential.has(warning));
      if (index < 0) break;
      response.warnings.splice(index, 1);
    }
    if (size() > maxOutputBytes) throw new Error('Output byte limit is too small for this workspace response.');
  }
  return { response, candidates };
}

export function context(request: NanoContextRequest): NanoContextResponse {
  return collectContext(request).response;
}

/** Evaluation hook: candidates before top-k, verification, and byte limits. */
export function contextWithCandidates(request: NanoContextRequest): { response: NanoContextResponse; candidates: string[] } {
  return collectContext(request);
}
