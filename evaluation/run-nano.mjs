import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(project, 'evaluation/nano-tasks.v1.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const temp = mkdtempSync(path.join(tmpdir(), 'dhruv-nano-eval-'));
const npm = [process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => candidate && existsSync(candidate));
assert.ok(npm, 'npm CLI unavailable');
const command = (exe, args, cwd, timeout = 180_000) => execFileSync(exe, args,
  { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fraction = (n, d) => d === 0 ? null : n / d;
const wilson = (n, d) => {
  if (!d) return null;
  const z = 1.96, p = n / d, base = 1 + z * z / d;
  const center = (p + z * z / (2 * d)) / base;
  const radius = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d)) / base;
  return [center - radius, center + radius];
};
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const verifyFact = (root, file, fact, task) => {
  const filename = path.join(root, file.path);
  if (!existsSync(filename)) return 'invalid';
  const source = readFileSync(filename, 'utf8');
  const lines = source.split('\n');
  const matchLine = (term, line) => Number.isInteger(line) && line > 0 &&
    line <= lines.length && lines[line - 1].toLowerCase().includes(term.toLowerCase());
  if (fact.kind === 'path') {
    if (fact.detail === 'Task names this on-disk path.') return task.toLowerCase().includes(file.path.toLowerCase()) ||
      task.toLowerCase().includes(path.basename(file.path).toLowerCase()) ? 'valid' : 'invalid';
    const term = /^Path contains (.+)\.$/.exec(fact.detail)?.[1];
    return term && file.path.toLowerCase().includes(term) ? 'valid' : 'invalid';
  }
  if (fact.kind === 'text') {
    const term = /^Text contains (.+)\.$/.exec(fact.detail)?.[1];
    return term && matchLine(term, fact.line) ? 'valid' : 'invalid';
  }
  if (fact.kind === 'symbol') {
    const span = source.slice(fact.startOffset, fact.endOffset);
    return fact.fingerprint === sha256(source) && fact.line === fact.startLine &&
      lineAt(source, fact.startOffset) === fact.startLine &&
      lineAt(source, fact.endOffset - 1) === fact.endLine &&
      new RegExp(`\\b${fact.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(span) &&
      fact.detail === `Parsed ${fact.declarationKind} declaration for ${fact.symbol}.` ? 'valid' : 'invalid';
  }
  const sites = fact.kind === 'import' ? [{ importer: fact.importer, imported: fact.imported,
    specifier: fact.specifier, line: fact.line, startOffset: fact.startOffset }] :
    fact.kind === 'related-test' ? fact.imports : null;
  if (!sites) return 'unverifiable';
  if (fact.kind === 'import' && (file.path !== fact.importer ||
      fact.detail !== `Observed static ${fact.importKind} from ${fact.importer} to ${fact.imported}.`)) return 'invalid';
  if (fact.kind === 'related-test' && (sites.length < 1 || sites.length > 2 ||
      file.path !== sites.at(-1).importer || fact.source !== sites[0].imported ||
      fact.line !== sites.at(-1).line ||
      (sites.length === 1 && (fact.via !== undefined ||
        fact.detail !== `Test has an observed static import of ${fact.source}. This does not establish sufficient test coverage.`)) ||
      (sites.length === 2 && (fact.via !== sites[0].importer || sites[1].imported !== fact.via ||
        fact.detail !== `Test imports ${fact.via}, which imports ${fact.source}. This does not establish sufficient test coverage.`)))) return 'invalid';
  return sites.every(site => {
    const importer = path.join(root, site.importer), imported = path.join(root, site.imported);
    if (!existsSync(importer) || !existsSync(imported)) return false;
    const body = readFileSync(importer, 'utf8');
    const literal = body.slice(site.startOffset, site.startOffset + site.specifier.length + 2);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(site.importer), site.specifier));
    const resolved = target === site.imported || target.replace(/\.js$/, '.ts') === site.imported ||
      target.replace(/\.js$/, '.tsx') === site.imported ||
      ['.js', '.ts', '.mjs'].some(ext => `${target}${ext}` === site.imported) ||
      ['.js', '.ts'].some(ext => `${target}/index${ext}` === site.imported);
    return lineAt(body, site.startOffset) === site.line &&
      (literal === `'${site.specifier}'` || literal === `"${site.specifier}"`) && resolved;
  }) ? 'valid' : 'invalid';
};

try {
  const pack = JSON.parse(command(process.execPath,
    [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], project))[0];
  const archive = path.join(temp, pack.filename);
  const consumer = path.join(temp, 'consumer'); mkdirSync(consumer);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  command(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer);
  const installed = path.join(consumer, 'node_modules/@rahul05ranjan/dhruv-cli/dist');
  const entry = path.join(installed, 'index.js');
  const { contextWithCandidates } = await import(pathToFileURL(path.join(installed, 'nano/context.js')).href);
  const output = { date: new Date().toISOString(), manifestSha256: sha256(manifestBytes),
    packageSha256: sha256(readFileSync(archive)), packageBytes: pack.size,
    node: process.version, os: `${platform()} ${release()}`, repositories: [] };
  for (const repo of manifest.repositories) {
    const root = path.join(temp, repo.id);
    command('git', ['clone', '--quiet', '--no-checkout', repo.url, root], temp);
    command('git', ['checkout', '--quiet', repo.sha], root);
    assert.equal(command('git', ['rev-parse', 'HEAD'], root).trim(), repo.sha);
    const tasks = [];
    for (const task of repo.tasks) {
      const run = () => {
        const started = process.hrtime.bigint();
        const result = spawnSync(process.execPath, [entry, 'nano', 'context', task.task, '--json', '--top', '10'],
          { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${task.id}: ${result.stderr}`);
        return { response: JSON.parse(result.stdout.trim()), elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          stderr: result.stderr };
      };
      const cold = run();
      const warm = run();
      assert.deepEqual(cold.response.files, warm.response.files, `${task.id}: unstable file/evidence ordering`);
      assert.equal(cold.response.index.identity, warm.response.index.identity);
      const { candidates } = contextWithCandidates({ task: task.task, root, top: 10 });
      const gold = task.gold.map(item => item.path);
      for (const goldPath of gold) assert.ok(existsSync(path.join(root, goldPath)), `${task.id}: missing gold ${goldPath}`);
      const returned = cold.response.files.map(item => item.path);
      const facts = cold.response.files.flatMap(file => file.evidence.map(fact =>
        ({ path: file.path, kind: fact.kind, verdict: verifyFact(root, file, fact, task.task) })));
      tasks.push({ id: task.id, negative: task.negative === true, gold, uncertain: task.uncertain,
        candidates: candidates.length, candidateHits: gold.filter(p => candidates.includes(p)),
        top10: returned, top10Hits: gold.filter(p => returned.includes(p)),
        falsePositiveCount: task.negative ? returned.length : undefined,
        facts, coverage: cold.response.coverage, truncated: cold.response.truncated,
        indexFreshness: cold.response.index.freshness, coldMs: cold.elapsedMs, warmMs: warm.elapsedMs,
        stderr: cold.stderr || warm.stderr || undefined });
    }
    const positive = tasks.filter(task => !task.negative);
    const goldCount = positive.reduce((n, task) => n + task.gold.length, 0);
    const candidateHits = positive.reduce((n, task) => n + task.candidateHits.length, 0);
    const topHits = positive.reduce((n, task) => n + task.top10Hits.length, 0);
    const facts = tasks.flatMap(task => task.facts);
    output.repositories.push({ id: repo.id, sha: repo.sha, tasks, summary: {
      positiveTasks: positive.length, negativeTasks: tasks.length - positive.length, goldFiles: goldCount,
      candidateRecall: { n: candidateHits, N: goldCount, micro: fraction(candidateHits, goldCount),
        macro: positive.reduce((n, task) => n + task.candidateHits.length / task.gold.length, 0) / positive.length },
      recallAt10: { n: topHits, N: goldCount, micro: fraction(topHits, goldCount),
        macro: positive.reduce((n, task) => n + task.top10Hits.length / task.gold.length, 0) / positive.length },
      hitAnyAt10: positive.filter(task => task.top10Hits.length > 0).length,
      allGoldAt10: positive.filter(task => task.top10Hits.length === task.gold.length).length,
      evidence: { valid: facts.filter(f => f.verdict === 'valid').length, total: facts.length,
        invalid: facts.filter(f => f.verdict === 'invalid').length,
        unverifiable: facts.filter(f => f.verdict === 'unverifiable').length,
        wilson95: wilson(facts.filter(f => f.verdict === 'valid').length, facts.length) },
    } });
  }
  const result = JSON.stringify(output, null, 2);
  const destination = process.argv[2];
  if (destination) writeFileSync(path.resolve(destination), `${result}\n`);
  else console.log(result);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
