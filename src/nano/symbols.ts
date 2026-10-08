import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Persistable facts about one source file. No source body or task text is retained. */
export interface NanoParsedSource {
  path: string;
  fingerprint: string;
  language: 'typescript' | 'javascript' | 'unsupported';
  partial: boolean;
  symbols: NanoSymbolDeclaration[];
}

export interface NanoSymbolDeclaration {
  symbol: string;
  declarationKind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'method' | 'namespace';
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export function sourceFingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function sourceLanguage(relative: string): NanoParsedSource['language'] {
  if (/\.(?:ts|tsx|mts|cts)$/i.test(relative)) return 'typescript';
  if (/\.(?:js|jsx|mjs|cjs)$/i.test(relative)) return 'javascript';
  return 'unsupported';
}

/** Static parsing only: no module resolution, imports, transforms, or workspace code execution. */
export function parseSource(relative: string, source: string): NanoParsedSource {
  const fingerprint = sourceFingerprint(source);
  const language = sourceLanguage(relative);
  if (language === 'unsupported') return { path: relative, fingerprint, language, partial: false, symbols: [] };

  const extension = relative.toLowerCase();
  const scriptKind = extension.endsWith('.tsx') ? ts.ScriptKind.TSX
    : extension.endsWith('.jsx') ? ts.ScriptKind.JSX
      : language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const firstError = diagnostics.reduce((min, diagnostic) => Math.min(min, diagnostic.start ?? source.length), source.length);
  const firstErrorLine = file.getLineAndCharacterOfPosition(firstError).line + 1;
  const symbols: NanoSymbolDeclaration[] = [];
  const record = (node: ts.Node, name: ts.Node | undefined, declarationKind: NanoSymbolDeclaration['declarationKind']): void => {
    if (!name || !ts.isIdentifier(name)) return;
    const startOffset = node.getStart(file);
    const endOffset = node.getEnd();
    if (endOffset <= startOffset) return;
    const startLine = file.getLineAndCharacterOfPosition(startOffset).line + 1;
    const endLine = file.getLineAndCharacterOfPosition(endOffset - 1).line + 1;
    // A recovery node can end before the diagnostic offset on the same malformed line.
    if (diagnostics.length > 0 && endLine >= firstErrorLine) return;
    symbols.push({ symbol: name.text, declarationKind, startLine, endLine, startOffset, endOffset });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) record(node, node.name, 'function');
    else if (ts.isClassDeclaration(node)) record(node, node.name, 'class');
    else if (ts.isInterfaceDeclaration(node)) record(node, node.name, 'interface');
    else if (ts.isTypeAliasDeclaration(node)) record(node, node.name, 'type');
    else if (ts.isEnumDeclaration(node)) record(node, node.name, 'enum');
    else if (ts.isVariableDeclaration(node)) record(node, node.name, 'variable');
    else if (ts.isMethodDeclaration(node)) record(node, node.name, 'method');
    else if (ts.isModuleDeclaration(node)) record(node, node.name, 'namespace');
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { path: relative, fingerprint, language, partial: diagnostics.length > 0, symbols };
}

/** Checks a cached declaration against freshly parsed contents of the same file. */
export function hasCurrentDeclaration(parsed: NanoParsedSource, fingerprint: string, declaration: NanoSymbolDeclaration): boolean {
  return parsed.fingerprint === fingerprint && parsed.symbols.some((item) =>
    item.symbol === declaration.symbol && item.declarationKind === declaration.declarationKind &&
    item.startOffset === declaration.startOffset && item.endOffset === declaration.endOffset &&
    item.startLine === declaration.startLine && item.endLine === declaration.endLine);
}
