import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('Nano repository discovery', () => {
  it('finds dirty tracked and untracked files while applying Git, Nano, generated, and sensitive exclusions', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-git-'));
    const external = mkdtempSync(join(tmpdir(), 'dhruv-nano-external-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'package with spaces'));
      mkdirSync(join(workspace, 'dist'));
      mkdirSync(join(workspace, 'nested'));
      writeFileSync(join(workspace, '.gitignore'), 'ignored.ts\n');
      writeFileSync(join(workspace, '.nanoignore'), 'nano-ignored.ts\n');
      writeFileSync(join(workspace, 'tracked.ts'), 'export const original = 1;\n');
      writeFileSync(join(workspace, 'ignored.ts'), 'export const hiddenMarker = 1;\n');
      execFileSync('git', ['add', '.gitignore', '.nanoignore', 'tracked.ts'], { cwd: workspace });
      execFileSync('git', ['add', '-f', 'ignored.ts'], { cwd: workspace });
      writeFileSync(join(workspace, 'tracked.ts'), 'export const dirtyMarker = 1;\n');
      writeFileSync(join(workspace, 'package with spaces/ünicode name.ts'), 'export const unicodeMarker = 1;\n');
      writeFileSync(join(workspace, 'package with spaces/.nanoignore'), 'nested-hidden.ts\n');
      writeFileSync(join(workspace, 'package with spaces/nested-hidden.ts'), 'export const hiddenMarker = 1;\n');
      writeFileSync(join(workspace, 'untracked.ts'), 'export const untrackedMarker = 1;\n');
      writeFileSync(join(workspace, 'nano-ignored.ts'), 'export const hiddenMarker = 1;\n');
      writeFileSync(join(workspace, 'dist/generated.ts'), 'export const hiddenMarker = 1;\n');
      writeFileSync(join(workspace, '.env'), 'hiddenMarker=private\n');
      writeFileSync(join(workspace, 'credentials.json'), '{"hiddenMarker":"private"}\n');
      writeFileSync(join(external, 'outside.ts'), 'export const hiddenMarker = 1;\n');
      let symlinkSupported = true;
      try {
        symlinkSync(join(external, 'outside.ts'), join(workspace, 'outside.ts'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        symlinkSupported = false;
      }

      const nested = JSON.parse(run(join(workspace, 'nested'), 'nano', 'context', 'dirtyMarker untrackedMarker', '--json')) as {
        root: string; files: { path: string }[]; coverage: { partial: boolean }; warnings: string[];
      };
      expect(statSync(nested.root).ino).toBe(statSync(workspace).ino);
      expect(statSync(nested.root).dev).toBe(statSync(workspace).dev);
      expect(nested.files.map((file) => file.path)).toEqual(expect.arrayContaining(['tracked.ts', 'untracked.ts']));
      if (symlinkSupported) {
        expect(nested.coverage.partial).toBe(true);
        expect(nested.warnings).toContain('Some listed files were inaccessible or symlinked.');
      }

      const named = JSON.parse(run(workspace, 'nano', 'context', 'Inspect .env credentials.json ignored.ts nano-ignored.ts dist/generated.ts package with spaces/ünicode name.ts', '--json')) as {
        files: { path: string }[];
      };
      expect(named.files[0].path).toBe('package with spaces/ünicode name.ts');
      const selected = named.files.map((file) => file.path);
      for (const hidden of ['.env', 'credentials.json', 'ignored.ts', 'nano-ignored.ts', 'package with spaces/nested-hidden.ts', 'dist/generated.ts', 'outside.ts']) {
        expect(selected).not.toContain(hidden);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('restricts scope and rejects traversal and external symlink scopes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-scope-'));
    const external = mkdtempSync(join(tmpdir(), 'dhruv-nano-external-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'packages'));
      writeFileSync(join(workspace, 'packages/in-scope.ts'), 'export const scopeMarker = 1;\n');
      writeFileSync(join(workspace, 'outside-scope.ts'), 'export const scopeMarker = 1;\n');
      const scoped = JSON.parse(run(workspace, 'nano', 'context', 'scopeMarker', '--scope', 'packages', '--json')) as { files: { path: string }[] };
      expect(scoped.files.map((file) => file.path)).toEqual(['packages/in-scope.ts']);
      const invoke = (scope: string) => spawnSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', 'scopeMarker', '--scope', scope, '--json'], {
        cwd: workspace, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
      });
      const traversal = invoke('../');
      expect(traversal.status).toBe(2);
      expect(traversal.stdout).toBe('');
      expect(traversal.stderr).toContain('Scope must be inside the workspace root.');
      try {
        symlinkSync(external, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        const linked = invoke('linked');
        expect(linked.status).toBe(2);
        expect(linked.stdout).toBe('');
        expect(linked.stderr).toContain('Scope must be an accessible directory without symlinks.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
      const invalidRoot = spawnSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', 'scopeMarker', '--root', 'missing-root', '--json'], {
        cwd: workspace, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
      });
      expect(invalidRoot.status).toBe(2);
      expect(invalidRoot.stdout).toBe('');
      expect(invalidRoot.stderr).toContain('Workspace root must be an accessible directory.');
      const unavailableGit = spawnSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', 'scopeMarker', '--json'], {
        cwd: workspace, encoding: 'utf8', env: { ...process.env, PATH: '', TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
      });
      expect(unavailableGit.status).toBe(2);
      expect(unavailableGit.stdout).toBe('');
      expect(unavailableGit.stderr).toContain('Git root discovery failed.');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('uses a bounded non-Git directory fallback with Nano exclusions', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-plain-'));
    try {
      mkdirSync(join(workspace, 'src'));
      mkdirSync(join(workspace, 'dist'));
      writeFileSync(join(workspace, '.nanoignore'), 'ignored.ts\n');
      writeFileSync(join(workspace, 'src/new file.ts'), 'export const fallbackMarker = 1;\n');
      writeFileSync(join(workspace, 'ignored.ts'), 'export const fallbackMarker = 1;\n');
      writeFileSync(join(workspace, 'dist/generated.ts'), 'export const fallbackMarker = 1;\n');
      writeFileSync(join(workspace, '.env.local'), 'fallbackMarker=private\n');
      const result = JSON.parse(run(workspace, 'nano', 'context', 'fallbackMarker', '--json')) as {
        root: string; files: { path: string }[]; coverage: { partial: boolean };
      };
      expect(statSync(result.root).ino).toBe(statSync(workspace).ino);
      expect(statSync(result.root).dev).toBe(statSync(workspace).dev);
      expect(result.files.map((file) => file.path)).toEqual(['src/new file.ts']);
      expect(result.coverage.partial).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
