import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(__dirname, '..');
const entry = resolve(project, 'src/index.ts');
const loader = pathToFileURL(resolve(project, 'node_modules/ts-node/esm.mjs')).href;

interface Evidence {
  kind: string;
  basis: string;
  importer?: string;
  imported?: string;
  source?: string;
  via?: string;
  imports?: { importer: string; imported: string; line: number }[];
  verified?: boolean;
}
interface Result {
  files: { path: string; evidence: Evidence[] }[];
  coverage: { partial: boolean };
  index: { reused: number };
  warnings: string[];
}

function context(cwd: string, task: string): Result {
  return JSON.parse(execFileSync(process.execPath, ['--loader', loader, entry, 'nano', 'context', task, '--json', '--top', '30'], {
    cwd, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(project, 'tsconfig.json') },
  })) as Result;
}

describe('Nano observed import relationships', () => {
  it('follows a source declaration to an importer and related test with import-site evidence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-relations-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, 'src'));
      mkdirSync(join(workspace, '__tests__'));
      writeFileSync(join(workspace, 'src/token.ts'), 'export function refreshToken() { return "fresh"; }\n');
      writeFileSync(join(workspace, 'src/consumer.ts'), [
        'import { refreshToken } from "./token.js";',
        'export function callRefresh() { return refreshToken(); }',
        '',
      ].join('\n'));
      writeFileSync(join(workspace, '__tests__/consumer.test.ts'), [
        'import { callRefresh } from "../src/consumer.js";',
        'it("calls refresh", () => { callRefresh(); });',
        '',
      ].join('\n'));
      writeFileSync(join(workspace, '__tests__/token.test.ts'), '// refreshToken is named here, but there is no observed import.\n');

      const result = context(workspace, 'Repair refreshToken');
      expect(result.files[0]).toEqual(expect.objectContaining({ path: 'src/token.ts' }));
      const importer = result.files.find((file) => file.path === 'src/consumer.ts');
      expect(importer?.evidence).toContainEqual(expect.objectContaining({
        kind: 'import', basis: 'static-import', verified: true,
        importer: 'src/consumer.ts', imported: 'src/token.ts', line: 1,
      }));
      const test = result.files.find((file) => file.path === '__tests__/consumer.test.ts');
      expect(test?.evidence).toContainEqual(expect.objectContaining({
        kind: 'related-test', basis: 'static-import', verified: true,
        source: 'src/token.ts', via: 'src/consumer.ts',
        imports: [expect.objectContaining({ importer: 'src/consumer.ts', imported: 'src/token.ts', line: 1 }),
          expect.objectContaining({ importer: '__tests__/consumer.test.ts', imported: 'src/consumer.ts', line: 1 })],
      }));
      expect(result.files.map((file) => file.path)).not.toContain('__tests__/token.test.ts');
      expect(result.warnings.join(' ')).toMatch(/not sufficient to prove correctness/);

      const repeated = context(workspace, 'Repair refreshToken');
      expect(repeated.index.reused).toBeGreaterThan(0);
      expect(repeated.files.find((file) => file.path === '__tests__/consumer.test.ts')?.evidence)
        .toContainEqual(expect.objectContaining({ kind: 'related-test', verified: true }));

      writeFileSync(join(workspace, '__tests__/consumer.test.ts'), 'it("no import", () => {});\n');
      const changed = context(workspace, 'Repair refreshToken');
      expect(changed.files.map((file) => file.path)).not.toContain('__tests__/consumer.test.ts');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('bounds broad importers and labels unresolved imports and cycles', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dhruv-nano-relations-bounded-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      writeFileSync(join(workspace, 'shared.ts'), 'import "./consumer00.js";\nexport const sharedHelper = 1;\n');
      for (let index = 0; index < 16; index++) {
        const suffix = String(index).padStart(2, '0');
        writeFileSync(join(workspace, `consumer${suffix}.ts`), `import { sharedHelper } from "./shared.js";\nexport const marker${suffix} = sharedHelper;\n`);
      }
      writeFileSync(join(workspace, 'unresolved.ts'), 'import "./missing.js";\n');
      const result = context(workspace, 'Repair sharedHelper');
      expect(result.files[0].path).toBe('shared.ts');
      expect(result.files.filter((file) => file.evidence.some((item) => item.kind === 'import')).length).toBeLessThanOrEqual(12);
      expect(result.coverage.partial).toBe(true);
      expect(result.warnings.join(' ')).toMatch(/unresolved or ambiguous/);
      expect(result.warnings.join(' ')).toMatch(/more direct importers/);
      expect(result.warnings.join(' ')).toMatch(/import cycle/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
