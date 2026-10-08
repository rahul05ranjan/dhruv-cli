import path from 'node:path';
import ts from 'typescript';

/** Persistable syntax facts. Paths are resolved later against the current permitted file set. */
export interface NanoImportDeclaration {
  specifier: string;
  kind: 'import' | 'export' | 'require';
  line: number;
  startOffset: number;
}

export interface NanoImportSite extends NanoImportDeclaration {
  importer: string;
  imported: string;
}

export interface NanoImportEvidence {
  kind: 'import';
  basis: 'static-import';
  detail: string;
  verified: true;
  importer: string;
  imported: string;
  specifier: string;
  importKind: NanoImportDeclaration['kind'];
  line: number;
  startOffset: number;
}

export interface NanoRelatedTestEvidence {
  kind: 'related-test';
  basis: 'static-import';
  detail: string;
  verified: true;
  source: string;
  via?: string;
  imports: NanoImportSite[];
  line: number;
}

export interface NanoRelationshipSuggestion {
  path: string;
  evidence: NanoImportEvidence | NanoRelatedTestEvidence;
  score: number;
}

export interface NanoRelationshipResult {
  suggestions: NanoRelationshipSuggestion[];
  warnings: string[];
  partial: boolean;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const MAX_DIRECT_IMPORTERS = 12;
const MAX_TESTS_PER_SOURCE = 12;
const MAX_SUGGESTIONS = 40;

function scriptKind(relative: string): ts.ScriptKind {
  if (relative.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relative.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return /\.(?:ts|mts|cts)$/.test(relative) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** Records literal, static import sites without loading the imported module. */
export function parseLocalImports(relative: string, source: string): NanoImportDeclaration[] {
  if (!/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i.test(relative)) return [];
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind(relative));
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const firstError = diagnostics.reduce((min, item) => Math.min(min, item.start ?? source.length), source.length);
  const found: NanoImportDeclaration[] = [];
  const record = (literal: ts.Expression | undefined, kind: NanoImportDeclaration['kind']): void => {
    if (!literal || !ts.isStringLiteral(literal) || literal.getStart(file) >= firstError) return;
    found.push({ specifier: literal.text, kind, line: file.getLineAndCharacterOfPosition(literal.getStart(file)).line + 1,
      startOffset: literal.getStart(file) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) record(node.moduleSpecifier, 'import');
    else if (ts.isExportDeclaration(node)) record(node.moduleSpecifier, 'export');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression, 'require');
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1) {
      record(node.arguments[0], 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function candidates(importer: string, specifier: string): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return [];
  const extension = path.posix.extname(joined);
  const matches = new Set<string>();
  if (extension) {
    matches.add(joined);
    // TS projects commonly write the eventual emitted JS extension in source imports.
    const replacements: Record<string, string[]> = {
      '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
    };
    for (const replacement of replacements[extension] ?? []) matches.add(joined.slice(0, -extension.length) + replacement);
  } else {
    for (const suffix of EXTENSIONS) matches.add(joined + suffix);
    for (const suffix of EXTENSIONS) matches.add(path.posix.join(joined, `index${suffix}`));
  }
  return [...matches];
}

export function resolveLocalImport(importer: string, specifier: string, permitted: ReadonlySet<string>): string | undefined {
  const matches = candidates(importer, specifier).filter((candidate) => permitted.has(candidate));
  return matches.length === 1 ? matches[0] : undefined;
}

export function isTestPath(relative: string): boolean {
  return /(?:^|\/)(?:__tests__|test|tests)\//i.test(relative) || /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/i.test(relative);
}

/** Expand one observed reverse-import hop, then only test files on a second hop. */
export function buildRelationshipSuggestions(importsByFile: ReadonlyMap<string, readonly NanoImportDeclaration[]>, seedPaths: readonly string[]): NanoRelationshipResult {
  const permitted = new Set(importsByFile.keys());
  const reverse = new Map<string, NanoImportSite[]>();
  const warnings: string[] = [];
  const warn = (message: string): void => { if (!warnings.includes(message)) warnings.push(message); };
  for (const [importer, imports] of importsByFile) {
    for (const item of imports) {
      const target = resolveLocalImport(importer, item.specifier, permitted);
      if (!target) {
        if (item.specifier.startsWith('.')) warn('Some local imports were unresolved or ambiguous; relationship mapping is incomplete.');
        else warn('Package or alias imports are outside local relationship mapping.');
        continue;
      }
      const sites = reverse.get(target) ?? [];
      sites.push({ ...item, importer, imported: target });
      reverse.set(target, sites);
    }
  }
  for (const sites of reverse.values()) sites.sort((a, b) =>
    (a.importer < b.importer ? -1 : a.importer > b.importer ? 1 : 0) || a.startOffset - b.startOffset);
  const suggestions: NanoRelationshipSuggestion[] = [];
  const emitted = new Set<string>();
  let partial = warnings.some((warning) => warning.includes('unresolved or ambiguous'));
  for (const source of [...new Set(seedPaths)].sort()) {
    const incoming = (reverse.get(source) ?? []).filter((site, index, sites) =>
      sites.findIndex((candidate) => candidate.importer === site.importer) === index);
    if (incoming.length > MAX_DIRECT_IMPORTERS) { warn('A shared source has more direct importers than the relationship limit; mapping is incomplete.'); partial = true; }
    let tests = 0;
    for (const site of incoming.slice(0, MAX_DIRECT_IMPORTERS)) {
      if (site.importer === source) { warn('An import cycle was observed; relationship expansion is incomplete.'); partial = true; continue; }
      if (suggestions.length >= MAX_SUGGESTIONS) { warn('Relationship result limit reached; mapping is incomplete.'); partial = true; break; }
      if (isTestPath(site.importer)) {
        if (!emitted.has(site.importer)) {
          suggestions.push({ path: site.importer, score: 35, evidence: {
            kind: 'related-test', basis: 'static-import', verified: true,
            detail: `Test has an observed static import of ${source}. This does not establish sufficient test coverage.`,
            source, imports: [site], line: site.line,
          } });
          emitted.add(site.importer);
          tests++;
        }
        continue;
      }
      if (!emitted.has(site.importer)) {
        suggestions.push({ path: site.importer, score: 40, evidence: {
          kind: 'import', basis: 'static-import', verified: true,
          detail: `Observed static ${site.kind} from ${site.importer} to ${source}.`,
          importer: site.importer, imported: source, specifier: site.specifier, importKind: site.kind,
          line: site.line, startOffset: site.startOffset,
        } });
        emitted.add(site.importer);
      }
      const next = reverse.get(site.importer) ?? [];
      if (next.some((edge) => edge.importer === source)) { warn('An import cycle was observed; relationship expansion is incomplete.'); partial = true; }
      if (next.filter((edge) => isTestPath(edge.importer)).length > MAX_TESTS_PER_SOURCE) {
        warn('A source has more related tests than the relationship limit; mapping is incomplete.'); partial = true;
      }
      for (const testSite of next.filter((edge) => isTestPath(edge.importer)).slice(0, MAX_TESTS_PER_SOURCE)) {
        if (tests >= MAX_TESTS_PER_SOURCE || suggestions.length >= MAX_SUGGESTIONS) {
          warn('Related-test or relationship result limit reached; mapping is incomplete.'); partial = true; break;
        }
        if (emitted.has(testSite.importer)) continue;
        suggestions.push({ path: testSite.importer, score: 35, evidence: {
          kind: 'related-test', basis: 'static-import', verified: true,
          detail: `Test imports ${site.importer}, which imports ${source}. This does not establish sufficient test coverage.`,
          source, via: site.importer, imports: [site, testSite], line: testSite.line,
        } });
        emitted.add(testSite.importer);
        tests++;
      }
    }
  }
  if (suggestions.some((item) => item.evidence.kind === 'related-test')) warn('Related tests are observed connections only; this shortlist is not sufficient to prove correctness.');
  return { suggestions, warnings, partial };
}

export function hasCurrentImport(site: NanoImportSite, sources: ReadonlyMap<string, string>, permitted: ReadonlySet<string>): boolean {
  const source = sources.get(site.importer);
  if (source === undefined || !sources.has(site.imported)) return false;
  return parseLocalImports(site.importer, source).some((item) => item.specifier === site.specifier && item.kind === site.kind &&
    item.line === site.line && item.startOffset === site.startOffset && resolveLocalImport(site.importer, item.specifier, permitted) === site.imported);
}
