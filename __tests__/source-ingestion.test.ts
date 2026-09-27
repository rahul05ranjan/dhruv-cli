import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ingestSource } from '../src/core/source-ingestion';

describe('Source Ingestion (ingestSource)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ingest-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads a single source file returning a success outcome', () => {
    const file = path.join(root, 'main.ts');
    fs.writeFileSync(file, 'console.log("hello world");');

    const outcome = ingestSource(file);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toBe(file);
      expect(outcome.isDiff).toBe(false);
      expect(outcome.capped).toBe(false);
      expect(outcome.files).toHaveLength(1);
      expect(outcome.files[0].path).toBe('main.ts');
      expect(outcome.files[0].content).toBe('console.log("hello world");');
      expect(outcome.promptContent).toBe('console.log("hello world");');
    }
  });

  it('returns a not-found failure outcome when target does not exist', () => {
    const nonExistent = path.join(root, 'nonexistent.ts');

    const outcome = ingestSource(nonExistent);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('not-found');
      expect(outcome.target).toBe(nonExistent);
      expect(outcome.message).toBe(`Path "${nonExistent}" does not exist or could not be read.`);
    }
  });

  it('recursively ingests directory files while pruning ignored directories', () => {
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

    const outcome = ingestSource(root);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.files).toHaveLength(2);
      const paths = outcome.files.map((f: { path: string }) => f.path.replace(/\\/g, '/')).sort();
      expect(paths).toEqual(['src/deep/util.js', 'src/index.ts']);
      expect(outcome.promptContent).toContain('// File: src/index.ts');
      expect(outcome.promptContent).toContain('// File: src/deep/util.js');
      expect(outcome.capped).toBe(false);
    }
  });

  it('caps directory collection at maxFiles and sets capped to true', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(root, 'src', `file_${String(i).padStart(2, '0')}.ts`), `const v = ${i};`);
    }

    const outcome = ingestSource(root, { maxFiles: 10 });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.files).toHaveLength(10);
      expect(outcome.capped).toBe(true);
      expect(outcome.maxFiles).toBe(10);
    }
  });

  it('returns a no-code-files failure outcome when directory contains no code files', () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'text only');

    const outcome = ingestSource(root);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('no-code-files');
      expect(outcome.target).toBe(root);
      expect(outcome.message).toBe(`No code files found in directory "${root}".`);
    }
  });

  it('ingests git diff when diff option is specified', () => {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

    const file = path.join(root, 'code.ts');
    fs.writeFileSync(file, 'const initial = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    fs.appendFileSync(file, 'const changed = 2;\n');

    const outcome = ingestSource(root, { diff: true });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.isDiff).toBe(true);
      expect(outcome.promptContent).toContain('+const changed = 2;');
    }
  });

  it('returns empty-diff failure outcome when git diff is empty', () => {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });

    const file = path.join(root, 'code.ts');
    fs.writeFileSync(file, 'const initial = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    const outcome = ingestSource(root, { diff: true });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('empty-diff');
      expect(outcome.target).toBe(root);
      expect(outcome.message).toBe(`No uncommitted changes found in "${root}".`);
    }
  });
});
