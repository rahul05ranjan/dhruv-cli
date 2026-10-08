import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(__dirname, '..');
const entry = resolve(project, 'src/index.ts');
const loader = pathToFileURL(resolve(project, 'node_modules/ts-node/esm.mjs')).href;

interface Evidence {
  kind: string;
  basis: string;
  symbol?: string;
  declarationKind?: string;
  startLine?: number;
  endLine?: number;
  verified?: boolean;
  fingerprint?: string;
}
interface Result {
  files: { path: string; evidence: Evidence[] }[];
  coverage: { partial: boolean };
  warnings: string[];
}

function context(cwd: string, task: string): Result {
  return JSON.parse(execFileSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', task, '--json'], {
    cwd, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
  })) as Result;
}

describe('Nano parsed symbol evidence', () => {
  it('ranks exact TypeScript and JavaScript declarations ahead of same-named text without executing source', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-symbol-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src/aaa-usage.ts'), '// refreshToken is mentioned here but never declared.\n');
      writeFileSync(join(workspace, 'src/token.ts'), [
        '// declaration follows',
        '// another comment',
        'export function refreshToken() {',
        '  return "fresh";',
        '}',
        '',
      ].join('\n'));
      writeFileSync(join(workspace, 'src/widget.js'), 'export class RenderWidget {}\n');
      writeFileSync(join(workspace, 'src/execution.ts'), 'import { writeFileSync } from "node:fs";\nwriteFileSync("executed", "yes");\nexport const executionMarker = 1;\n');

      const tsResult = context(workspace, 'Repair refreshToken');
      expect(tsResult.files[0].path).toBe('src/token.ts');
      expect(tsResult.files[0].evidence).toContainEqual(expect.objectContaining({
        kind: 'symbol', basis: 'syntax', symbol: 'refreshToken', declarationKind: 'function',
        startLine: 3, endLine: 5, verified: true, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
      expect(tsResult.files[1].path).toBe('src/aaa-usage.ts');
      expect(tsResult.files[1].evidence.every((item) => item.kind !== 'symbol')).toBe(true);

      const jsResult = context(workspace, 'Repair RenderWidget');
      expect(jsResult.files[0].path).toBe('src/widget.js');
      expect(jsResult.files[0].evidence).toContainEqual(expect.objectContaining({
        kind: 'symbol', symbol: 'RenderWidget', declarationKind: 'class', startLine: 1, endLine: 1, verified: true,
      }));
      const execution = context(workspace, 'executionMarker');
      expect(execution.files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', symbol: 'executionMarker' }));
      expect(existsSync(join(workspace, 'executed'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps only declarations before syntax errors and labels unsupported lexical evidence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-partial-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      writeFileSync(join(workspace, 'broken.ts'), 'export function validMarker() { return 1; }\nexport const brokenMarker = ;\n');
      writeFileSync(join(workspace, 'script.py'), 'def pythonMarker():\n    return 1\n');
      const valid = context(workspace, 'validMarker');
      expect(valid.files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', symbol: 'validMarker', verified: true }));
      expect(valid.coverage.partial).toBe(true);
      expect(valid.warnings).toContain('Some TypeScript or JavaScript files have syntax errors; declaration evidence is partial.');

      const broken = context(workspace, 'brokenMarker');
      expect(broken.files[0].evidence.some((item) => item.kind === 'symbol')).toBe(false);
      const unsupported = context(workspace, 'pythonMarker');
      expect(unsupported.files[0].path).toBe('script.py');
      expect(unsupported.files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'text', basis: 'lexical' }));
      expect(unsupported.files[0].evidence.some((item) => item.kind === 'symbol')).toBe(false);
      expect(unsupported.warnings).toContain('Some matched files use unsupported languages; path and text evidence only.');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports only current declaration locations after files change or disappear', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-fresh-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      const filename = join(workspace, 'change.ts');
      writeFileSync(filename, 'export const changingMarker = 1;\n');
      const original = context(workspace, 'changingMarker');
      const first = original.files[0].evidence.find((item) => item.kind === 'symbol');
      expect(first).toEqual(expect.objectContaining({ symbol: 'changingMarker', startLine: 1 }));

      writeFileSync(filename, '\n\nexport const changingMarker = 2;\n');
      const changed = context(workspace, 'changingMarker');
      const second = changed.files[0].evidence.find((item) => item.kind === 'symbol');
      expect(second).toEqual(expect.objectContaining({ symbol: 'changingMarker', startLine: 3 }));
      expect(second?.fingerprint).not.toBe(first?.fingerprint);

      writeFileSync(filename, 'export const renamedMarker = 3;\n');
      expect(context(workspace, 'changingMarker').files).toEqual([]);
      expect(context(workspace, 'renamedMarker').files[0].evidence).toContainEqual(expect.objectContaining({
        kind: 'symbol', symbol: 'renamedMarker', startLine: 1,
      }));
      rmSync(filename);
      expect(context(workspace, 'renamedMarker').files).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
