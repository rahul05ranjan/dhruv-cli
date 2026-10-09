import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(__dirname, '..');
const entry = resolve(project, 'src/index.ts');
const loader = pathToFileURL(resolve(project, 'node_modules/ts-node/esm.mjs')).href;

interface Response {
  schemaVersion: number;
  files: { path: string; rankingSignal: number; evidence: { kind: string; line?: number; startLine?: number }[] }[];
  index: { identity: string | null; freshness: string };
  coverage: { partial: boolean };
  truncated: boolean;
  warnings: string[];
}

function invoke(cwd: string, task: string, ...options: string[]) {
  return spawnSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', task, '--json', ...options], {
    cwd, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json'), DHRUV_METRICS_ENABLED: 'false' },
  });
}

function context(cwd: string, task: string, ...options: string[]): Response {
  const result = invoke(cwd, task, ...options);
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Response;
}

describe('Nano bounded response contract', () => {
  it('orders explicit verified paths and declarations before weak matches, with stable ranks and short weak output', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-response-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src/z-named.ts'), 'export function refreshToken() { return true; }\n');
      writeFileSync(join(workspace, 'src/a-mentioned.ts'), '// refreshToken is mentioned, not declared.\n');
      for (let index = 0; index < 8; index++) writeFileSync(join(workspace, `src/weak${index}.ts`), '// commonMarker\n');

      const first = context(workspace, 'Repair refreshToken in src/a-mentioned.ts');
      const repeated = context(workspace, 'Repair refreshToken in src/a-mentioned.ts');
      expect(first.files.map((file) => file.path)).toEqual(repeated.files.map((file) => file.path));
      expect(first.index.identity).toBe(repeated.index.identity);
      expect(first.files[0].path).toBe('src/a-mentioned.ts');
      expect(first.files[1].path).toBe('src/z-named.ts');
      expect(first.files[1].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 1 }));
      expect(first.files.every((file) => Number.isInteger(file.rankingSignal))).toBe(true);

      const weak = context(workspace, 'commonMarker', '--top', '30');
      expect(weak.files).toHaveLength(3);
      expect(weak.files.map((file) => file.path)).toEqual(['src/weak0.ts', 'src/weak1.ts', 'src/weak2.ts']);
      expect(weak.truncated).toBe(true);
      expect(weak.warnings.join(' ')).toMatch(/Only weak lexical matches/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('caps the complete JSON document, including evidence, and rejects invalid limits without stdout', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-bytes-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      for (let index = 0; index < 12; index++) {
        writeFileSync(join(workspace, `feature${String(index).padStart(2, '0')}.ts`), `export const targetMarker = ${index};\n`);
      }
      const result = invoke(workspace, 'Repair targetMarker', '--top', '30', '--max-output-bytes', '1024');
      expect(result.status).toBe(0);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      const response = JSON.parse(result.stdout) as Response;
      expect(response.schemaVersion).toBe(1);
      expect(response.truncated).toBe(true);
      expect(response.warnings.join(' ')).toMatch(/Output byte limit reached/);
      expect(response.files.length).toBeLessThan(12);
      expect(response.files.every((file) => file.evidence.length > 0)).toBe(true);

      const invalid = invoke(workspace, 'Repair targetMarker', '--max-output-bytes', '8');
      expect(invalid.status).toBe(2);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('Output byte limit');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports partial refresh and no match without stale source spans', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-response-refresh-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      writeFileSync(join(workspace, 'a.ts'), 'export const oldMarker = 1;\n');
      writeFileSync(join(workspace, 'b.ts'), 'export const otherMarker = 1;\n');
      expect(context(workspace, 'oldMarker').files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 1 }));
      writeFileSync(join(workspace, 'a.ts'), '\nexport const newMarker = 2;\n');
      expect(context(workspace, 'oldMarker').files).toEqual([]);
      expect(context(workspace, 'newMarker').files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 2 }));
      rmSync(join(workspace, 'a.ts'));
      expect(context(workspace, 'newMarker').files).toEqual([]);
      const partial = context(workspace, 'otherMarker', '--max-refresh-files', '1');
      expect(partial.coverage.partial).toBe(false);
      writeFileSync(join(workspace, 'a.ts'), 'export const newMarker = 3;\n');
      const limited = context(workspace, 'otherMarker', '--max-refresh-files', '1');
      expect(limited.coverage.partial).toBe(true);
      expect(limited.files).toEqual([]);
      expect(limited.warnings.join(' ')).toMatch(/Coverage is partial/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
