import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(__dirname, '..');
const entry = resolve(project, 'src/index.ts');
const loader = pathToFileURL(resolve(project, 'node_modules/ts-node/esm.mjs')).href;

interface Result {
  command: string;
  files?: { path: string; evidence: { kind: string; startLine?: number }[] }[];
  coverage: { discovered: number; scanned: number; reused?: number; partial: boolean };
  index?: { identity: string | null; freshness: string; reused: number };
  freshness?: string;
  identity?: string | null;
  warnings: string[];
}

function nano(cwd: string, command: string, ...args: string[]): Result {
  return JSON.parse(execFileSync(process.execPath, ['--loader', loader, entry, 'nano', command, ...args, '--json'], {
    cwd, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json'), DHRUV_METRICS_ENABLED: 'false' },
  })) as Result;
}

function fixture(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-index-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  mkdirSync(join(workspace, 'src'));
  return workspace;
}

describe('Nano index CLI lifecycle', () => {
  it('builds on demand, reuses verified facts, refreshes edits and deletion, and purges only Nano state', () => {
    const workspace = fixture();
    try {
      const filename = join(workspace, 'src', 'token.ts');
      const secretBody = 'privateRawBodyShouldNeverBeStored';
      writeFileSync(filename, `export function refreshToken() { return '${secretBody}'; }\n`);
      writeFileSync(join(workspace, 'keep.txt'), 'keep me');
      const phrase = 'Find refreshToken and do-not-store-this-task-phrase';
      const first = nano(workspace, 'context', phrase);
      const state = join(workspace, '.nano', 'index-v1.json');
      expect(first.files?.[0].path).toBe('src/token.ts');
      expect(first.index?.freshness).toBe('fresh');
      expect(existsSync(state)).toBe(true);
      const onDisk = readFileSync(state, 'utf8');
      expect(onDisk).not.toContain(secretBody);
      expect(onDisk).not.toContain(phrase);
      expect(onDisk).not.toContain('export function refreshToken()');
      expect(onDisk).not.toContain('diagnostic');

      const repeat = nano(workspace, 'context', 'refreshToken');
      expect(repeat.index?.identity).toBe(first.index?.identity);
      expect(repeat.index?.reused).toBeGreaterThan(0);
      expect(repeat.files?.[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 1 }));
      expect(nano(workspace, 'status').freshness).toBe('fresh');

      writeFileSync(filename, '\n\nexport function refreshToken() { return 2; }\n');
      expect(nano(workspace, 'status').freshness).toBe('stale');
      const changed = nano(workspace, 'context', 'refreshToken');
      expect(changed.files?.[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 3 }));
      expect(changed.index?.identity).not.toBe(first.index?.identity);
      rmSync(filename);
      const deleted = nano(workspace, 'context', 'refreshToken');
      expect(deleted.files).toEqual([]);
      expect(deleted.coverage.discovered).toBeGreaterThanOrEqual(1);
      expect(readFileSync(state, 'utf8')).not.toContain('src/token.ts');

      expect(nano(workspace, 'purge').freshness).toBe('purged');
      expect(existsSync(state)).toBe(false);
      expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('keep me');
      expect(nano(workspace, 'status').freshness).toBe('missing');
      expect(nano(workspace, 'index').freshness).toBe('fresh');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ignores interrupted temporary files, repairs a corrupt snapshot, and never serves unverified facts under a budget', () => {
    const workspace = fixture();
    try {
      writeFileSync(join(workspace, 'src', 'a.ts'), 'export const alphaMarker = 1;\n');
      writeFileSync(join(workspace, 'src', 'b.ts'), 'export const betaMarker = 1;\n');
      const state = join(workspace, '.nano', 'index-v1.json');
      expect(nano(workspace, 'index').freshness).toBe('fresh');
      writeFileSync(join(workspace, '.nano', 'index-v1.json.interrupted.tmp'), '{');
      expect(nano(workspace, 'status').freshness).toBe('fresh');

      writeFileSync(join(workspace, 'src', 'b.ts'), '\nexport const betaMarker = 2;\n');
      const partial = nano(workspace, 'context', 'betaMarker', '--max-refresh-files', '1');
      expect(partial.coverage.partial).toBe(true);
      expect(partial.files).toEqual([]);
      expect(partial.index?.freshness).toBe('partial');

      writeFileSync(state, '{"snapshot":');
      expect(nano(workspace, 'status').freshness).toBe('corrupt');
      const recovered = nano(workspace, 'context', 'betaMarker');
      expect(recovered.files?.[0].evidence).toContainEqual(expect.objectContaining({ kind: 'symbol', startLine: 2 }));
      expect(recovered.warnings).toContain('The Nano index was corrupt or incompatible; current files are being rebuilt.');
      expect(nano(workspace, 'status').freshness).toBe('fresh');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
