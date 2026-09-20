import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSource } from '../src/core/source-bundle';

jest.mock('../src/utils/ux', () => ({
  printError: jest.fn(),
  printInfo: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
}));

describe('Source Ingestion Module (loadSource)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bundle-test-'));
    process.exitCode = 0;
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('loads a single source file', () => {
    const file = path.join(root, 'main.ts');
    fs.writeFileSync(file, 'console.log("hello world");');

    const bundle = loadSource(file);

    expect(bundle).not.toBeNull();
    expect(bundle?.isDiff).toBe(false);
    expect(bundle?.capped).toBe(false);
    expect(bundle?.files).toHaveLength(1);
    expect(bundle?.files[0].path).toBe('main.ts');
    expect(bundle?.files[0].content).toBe('console.log("hello world");');
    expect(bundle?.promptContent).toBe('console.log("hello world");');
    expect(process.exitCode).toBe(0);
  });

  it('sets process.exitCode = 1 and returns null when target does not exist', () => {
    const nonExistent = path.join(root, 'nonexistent.ts');

    const bundle = loadSource(nonExistent);

    expect(bundle).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('recursively loads directory files while pruning dependency and build directories', () => {
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, '.next'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'util.js'), 'export const b = 2;');
    fs.writeFileSync(path.join(root, 'node_modules', 'lib', 'index.js'), 'ignored');
    fs.writeFileSync(path.join(root, '.next', 'bundle.js'), 'ignored');
    fs.writeFileSync(path.join(root, 'dist', 'out.js'), 'ignored');
    fs.writeFileSync(path.join(root, 'readme.md'), '# Markdown ignored');

    const bundle = loadSource(root);

    expect(bundle).not.toBeNull();
    expect(bundle?.files).toHaveLength(2);
    const paths = bundle?.files.map((f: { path: string }) => f.path.replace(/\\/g, '/')).sort();
    expect(paths).toEqual(['src/deep/util.js', 'src/index.ts']);
    expect(bundle?.promptContent).toContain('// File: src/index.ts');
    expect(bundle?.promptContent).toContain('// File: src/deep/util.js');
    expect(bundle?.capped).toBe(false);
  });

  it('caps directory collection at maxFiles and sets capped to true', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(root, 'src', `file_${String(i).padStart(2, '0')}.ts`), `const v = ${i};`);
    }

    const bundle = loadSource(root, { maxFiles: 10 });

    expect(bundle).not.toBeNull();
    expect(bundle?.files).toHaveLength(10);
    expect(bundle?.capped).toBe(true);
  });

  it('returns null and sets process.exitCode = 1 when directory contains no code files', () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'text only');

    const bundle = loadSource(root);

    expect(bundle).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('loads git diff when diff option is specified', () => {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

    const file = path.join(root, 'code.ts');
    fs.writeFileSync(file, 'const initial = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    fs.appendFileSync(file, 'const changed = 2;\n');

    const bundle = loadSource(root, { diff: true });

    expect(bundle).not.toBeNull();
    expect(bundle?.isDiff).toBe(true);
    expect(bundle?.promptContent).toContain('+const changed = 2;');
    expect(process.exitCode).toBe(0);
  });

  it('returns null and sets exitCode = 1 when git diff is empty', () => {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

    const file = path.join(root, 'code.ts');
    fs.writeFileSync(file, 'const initial = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    const bundle = loadSource(root, { diff: true });

    expect(bundle).toBeNull();
    expect(process.exitCode).toBe(1);
  });
});
