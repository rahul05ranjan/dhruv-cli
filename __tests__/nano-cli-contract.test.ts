import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(__dirname, '..');
const entry = resolve(project, 'src/index.ts');
const loader = pathToFileURL(resolve(project, 'node_modules/ts-node/esm.mjs')).href;

function run(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, ['--loader', loader, entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
  });
}

describe('Nano CLI contract', () => {
  it('returns a verified path first without loading workspace plugins or creating telemetry', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'src'));
      mkdirSync(join(workspace, 'plugins'));
      writeFileSync(join(workspace, 'package.json'), '{"type":"module"}');
      writeFileSync(join(workspace, 'src/token.ts'), 'export function refreshToken() { return "fresh"; }\n');
      writeFileSync(join(workspace, 'src/token.test.ts'), 'import { refreshToken } from "./token";\n');
      writeFileSync(join(workspace, 'src/widget.ts'), 'export function renderWidget() { return "widget"; }\n');
      writeFileSync(join(workspace, '.env'), 'TOKEN_SECRET=do-not-read\n');
      writeFileSync(join(workspace, 'plugins/marker.js'), 'import { writeFileSync } from "node:fs"; writeFileSync("plugin-executed", "yes");\n');

      const json = run(workspace, 'nano', 'context', 'Fix token refresh in src/token.ts', '--json');
      expect(json).not.toContain('\u001b[');
      const response = JSON.parse(json.trim()) as {
        schemaVersion: number;
        command: string;
        files: { path: string; evidence: { kind: string }[] }[];
      };
      expect(response.schemaVersion).toBe(1);
      expect(response.command).toBe('nano context');
      expect(response.files[0].path).toBe('src/token.ts');
      expect(response.files[0].evidence).toContainEqual(expect.objectContaining({ kind: 'path' }));
      expect(response.files.map((file) => file.path)).not.toContain('.env');

      const text = run(workspace, 'nano', 'context', 'Fix token refresh in src/token.ts');
      expect(text).toContain('src/token.ts');
      const empty = JSON.parse(run(workspace, 'nano', 'context', 'quasarfling', '--json')) as { files: unknown[]; warnings: string[] };
      expect(empty.files).toEqual([]);
      expect(empty.warnings).toContain('No supported file match was found for this task.');

      expect(existsSync(join(workspace, 'plugin-executed'))).toBe(false);
      expect(existsSync(join(workspace, '.dhruv-metrics.json'))).toBe(false);
      expect(existsSync(join(workspace, 'logs'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('exposes Nano in help and completion', () => {
    expect(run(project, '--help')).toContain('nano');
    expect(run(project, 'nano', '--help')).toContain('context');
    expect(run(project, 'completion', 'bash')).toContain('commands="context"');
  });
});
