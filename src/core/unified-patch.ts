/** Walk the new side of a unified diff hunk. Headers and metadata carry no line. */
export function walkUnifiedPatch(patch: string, visit: (text: string, line: number, kind: '+' | ' ' | '-' | '@') => void): void {
  let line = 0;
  let inHunk = false;
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      line = Number(header[1]);
      inHunk = true;
      visit(text, line, '@');
    } else if (inHunk && !text.startsWith('\\')) {
      const kind = text[0];
      if (kind === '+' || kind === ' ' || kind === '-') {
        visit(text.slice(1), line, kind);
        if (kind !== '-') line++;
      }
    }
  }
}
