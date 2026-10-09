import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles, resolveWorkspace } from '../src/nano/discovery';

describe('Nano discovery bounds', () => {
  it('reports partial coverage when the file or entry budget stops a non-Git scan', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-bounds-'));
    try {
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src/one.ts'), 'export const one = 1;\n');
      writeFileSync(join(workspace, 'src/two.ts'), 'export const two = 2;\n');
      const resolved = resolveWorkspace({ cwd: workspace });
      const fileBound = discoverFiles(resolved, { maxFiles: 1 });
      expect(fileBound.paths).toHaveLength(1);
      expect(fileBound.partial).toBe(true);
      expect(fileBound.warnings).toContain('Discovery file limit reached.');
      const entryBound = discoverFiles(resolved, { maxEntries: 1 });
      expect(entryBound.partial).toBe(true);
      expect(entryBound.warnings).toContain('Discovery entry limit reached.');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
