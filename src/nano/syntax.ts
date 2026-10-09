import ts from 'typescript';

/** Parse source once with consistent script kind and recovery boundary. */
export function parseSyntax(relative: string, source: string): {
  file: ts.SourceFile;
  diagnostics: readonly ts.Diagnostic[];
  firstError: number;
} {
  const extension = relative.toLowerCase();
  const scriptKind = extension.endsWith('.tsx') ? ts.ScriptKind.TSX
    : extension.endsWith('.jsx') ? ts.ScriptKind.JSX
      : /\.(?:ts|mts|cts)$/.test(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const firstError = diagnostics.reduce((min, diagnostic) => Math.min(min, diagnostic.start ?? source.length), source.length);
  return { file, diagnostics, firstError };
}
