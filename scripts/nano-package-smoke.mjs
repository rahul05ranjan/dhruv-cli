import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'dhruv-package-smoke-'));
const npmCandidates = [process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
const npm = npmCandidates.find(candidate => candidate && existsSync(candidate));
assert.ok(npm, 'npm CLI must be available beside the selected Node executable');

const invoke = (entry, cwd, args, maxBuffer = 1024 * 1024) => {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8',
    timeout: 30_000, maxBuffer, env: { ...process.env, NO_COLOR: '1' } });
  assert.ifError(result.error);
  return { ...result, milliseconds: Number(process.hrtime.bigint() - started) / 1e6 };
};
const json = (entry, cwd, args) => {
  const result = invoke(entry, cwd, args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_048_576, 'JSON stdout must be bounded');
  assert.ok(!result.stdout.includes('\u001b['), 'JSON stdout must contain no ANSI');
  return JSON.parse(result.stdout.trim());
};
const filesIn = directory => existsSync(directory)
  ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(full) : [{ path: full, bytes: statSync(full).size }];
  }) : [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  const pack = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
    { cwd: project, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))[0];
  const names = pack.files.map(file => file.path);
  for (const expected of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/nano/context.js', 'dist/nano/cli.js']) {
    assert.ok(names.includes(expected), `Missing packaged file: ${expected}`);
  }
  assert.ok(names.every(name => name === 'package.json' || name === 'README.md' || name === 'LICENSE' || name.startsWith('dist/')));
  assert.ok(names.every(name => !name.includes('.claude') && !name.includes('__tests__') && !name.includes('settings.local')));

  const consumer = path.join(temporary, 'consumer');
  const workspace = path.join(temporary, 'workspace with spaces');
  const plain = path.join(temporary, 'plain workspace');
  mkdirSync(consumer); mkdirSync(workspace); mkdirSync(plain);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, pack.filename)],
    { cwd: consumer, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const entry = path.join(consumer, 'node_modules/@rahul05ranjan/dhruv-cli/dist/index.js');
  assert.ok(existsSync(entry));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  mkdirSync(path.join(workspace, 'src')); mkdirSync(path.join(workspace, 'plugins'));
  writeFileSync(path.join(workspace, 'src/token.ts'), 'export function refreshToken() { return "fresh"; }\n');
  writeFileSync(path.join(workspace, 'src/token.test.ts'), 'import { refreshToken } from "./token";\n');
  writeFileSync(path.join(workspace, 'src/ünicode name.ts'), 'export const unicodeMarker = true;\n');
  writeFileSync(path.join(workspace, '.env'), 'SECRET=private\n');
  writeFileSync(path.join(workspace, 'plugins/marker.js'), 'throw Error("plugin executed")\n');

  const cold = json(entry, workspace, ['nano', 'context', 'Fix refreshToken in src/token.ts', '--json']);
  assert.equal(cold.schemaVersion, 1);
  assert.equal(cold.files[0].path, 'src/token.ts');
  assert.ok(cold.files.some(file => file.path === 'src/token.test.ts'));
  assert.ok(!cold.files.some(file => file.path === '.env'));
  assert.ok(existsSync(path.join(workspace, '.nano/index-v1.json')));
  const state = readFileSync(path.join(workspace, '.nano/index-v1.json'), 'utf8');
  assert.ok(!state.includes('Fix refreshToken') && !state.includes('return "fresh"') && !state.includes('SECRET=private'));
  assert.equal(json(entry, workspace, ['nano', 'status', '--json']).freshness, 'fresh');
  assert.equal(json(entry, workspace, ['nano', 'index', '--json']).freshness, 'fresh');
  const noMatch = json(entry, workspace, ['nano', 'context', 'quasarfling', '--json']);
  assert.deepEqual(noMatch.files, []);
  assert.equal(json(entry, workspace, ['nano', 'context', 'ünicode name.ts', '--json']).files[0].path, 'src/ünicode name.ts');
  writeFileSync(path.join(workspace, 'src/token.ts'), 'export function refreshToken() { return "changed"; }\n');
  const changed = json(entry, workspace, ['nano', 'context', 'refreshToken', '--json']);
  assert.notEqual(changed.index.identity, cold.index.identity);
  rmSync(path.join(workspace, 'src/token.ts'));
  const deleted = json(entry, workspace, ['nano', 'context', 'src/token.ts', '--json']);
  assert.ok(!deleted.files.some(file => file.path === 'src/token.ts'));
  assert.ok(!existsSync(path.join(workspace, 'logs')) && !existsSync(path.join(workspace, '.dhruv-metrics.json')));
  const footprint = filesIn(path.join(workspace, '.nano'));
  assert.equal(json(entry, workspace, ['nano', 'purge', '--json']).freshness, 'purged');
  assert.deepEqual(filesIn(path.join(workspace, '.nano')), []);

  writeFileSync(path.join(plain, 'plain marker.ts'), 'export const plainMarker = true;\n');
  assert.equal(json(entry, plain, ['nano', 'context', 'plainMarker', '--json']).files[0].path, 'plain marker.ts');

  const text = invoke(entry, workspace, ['nano', 'context', 'ünicode name.ts']);
  assert.equal(text.status, 0); assert.ok(text.stdout.includes('src/ünicode name.ts'));
  for (const args of [['nano', '--help'], ['--help'], ['completion', 'bash']]) {
    const result = invoke(entry, workspace, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.length > 0);
  }
  invoke(entry, workspace, ['nano', '--help']); // startup warm-up
  const startup = Array.from({ length: 5 }, () => invoke(entry, workspace, ['nano', '--help']).milliseconds);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, package: {
    filename: pack.filename, bytes: pack.size, unpackedBytes: pack.unpackedSize, fileCount: names.length,
  }, startupHelpMs: { median: median(startup), min: Math.min(...startup), max: Math.max(...startup) },
  index: { files: footprint.length, bytes: footprint.reduce((sum, file) => sum + file.bytes, 0) },
  checks: ['nano context/index/status/purge', 'JSON/text/help/completion', 'Git/non-Git workspace',
    'changed/deleted source', 'legacy help', 'no model'] }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
