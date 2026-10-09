import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { discoverFiles, safeFile, type NanoWorkspace } from './discovery.js';
import { parseSource, sourceFingerprint, type NanoParsedSource } from './symbols.js';

const STATE_DIRECTORY = '.nano';
const STATE_FILE = 'index-v1.json';
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REFRESH_FILES = 5000;
const DEFAULT_MAX_REFRESH_BYTES = 64 * 1024 * 1024;

interface IndexedFile {
  path: string;
  fingerprint: string;
  size: number;
  parsed: NanoParsedSource;
}

interface Snapshot {
  schemaVersion: 1;
  root: string;
  scope: string;
  identity: string;
  createdAt: string;
  files: IndexedFile[];
}

interface Envelope { checksum: string; snapshot: Snapshot }

export interface FreshIndexFile extends IndexedFile {
  /** Current source is available only in memory and is never serialized. */
  source: string;
}

export interface NanoIndexReport {
  schemaVersion: 1;
  command: 'nano index' | 'nano status' | 'nano purge';
  root: string;
  scope: string;
  identity: string | null;
  freshness: 'fresh' | 'partial' | 'missing' | 'stale' | 'corrupt' | 'purged';
  coverage: { discovered: number; scanned: number; reused: number; partial: boolean };
  exclusions: string;
  warnings: string[];
}

export interface RefreshResult {
  files: FreshIndexFile[];
  report: NanoIndexReport;
}

export interface RefreshOptions {
  maxFiles?: number;
  maxBytes?: number;
  persist?: boolean;
  force?: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function statePath(root: string): string {
  return path.join(root, STATE_DIRECTORY, STATE_FILE);
}

function canonical(snapshot: Snapshot): string {
  return JSON.stringify(snapshot);
}

function validFile(value: unknown): value is IndexedFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<IndexedFile>;
  return typeof file.path === 'string' && file.path.length > 0 && !path.isAbsolute(file.path) &&
    !file.path.split(/[\\/]/).some((part) => part === '..' || part === '.' || !part) &&
    typeof file.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(file.fingerprint) &&
    typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 &&
    !!file.parsed && file.parsed.path === file.path && file.parsed.fingerprint === file.fingerprint &&
    Array.isArray(file.parsed.symbols) && file.parsed.symbols.every((symbol) =>
      typeof symbol.symbol === 'string' && typeof symbol.startLine === 'number' &&
      typeof symbol.endLine === 'number' && typeof symbol.startOffset === 'number' &&
      typeof symbol.endOffset === 'number');
}

function readSnapshot(workspace: NanoWorkspace): { snapshot?: Snapshot; state: 'missing' | 'valid' | 'corrupt' } {
  const filename = statePath(workspace.root);
  try {
    const directory = lstatSync(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return { state: 'corrupt' };
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return { state: 'corrupt' };
    const envelope = JSON.parse(readFileSync(filename, 'utf8')) as Envelope;
    const snapshot = envelope?.snapshot;
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.root !== workspace.root ||
      snapshot.scope !== workspace.scope || typeof snapshot.identity !== 'string' ||
      typeof snapshot.createdAt !== 'string' || !Array.isArray(snapshot.files) ||
      !snapshot.files.every(validFile) || envelope.checksum !== sha256(canonical(snapshot)) ||
      snapshot.identity !== sha256(JSON.stringify([snapshot.root, snapshot.scope, snapshot.files.map((file) => [file.path, file.fingerprint])]))) {
      return { state: 'corrupt' };
    }
    return { snapshot, state: 'valid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt' };
  }
}

function writeSnapshot(workspace: NanoWorkspace, files: IndexedFile[]): Snapshot {
  const snapshot: Snapshot = {
    schemaVersion: 1,
    root: workspace.root,
    scope: workspace.scope,
    identity: sha256(JSON.stringify([workspace.root, workspace.scope, files.map((file) => [file.path, file.fingerprint])])),
    createdAt: new Date().toISOString(),
    files,
  };
  const data = JSON.stringify({ checksum: sha256(canonical(snapshot)), snapshot });
  if (Buffer.byteLength(data, 'utf8') > MAX_STATE_BYTES) throw new Error('Nano index exceeds its size limit.');
  const directory = path.join(workspace.root, STATE_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Nano state directory is a symlink.');
  const temporary = path.join(directory, `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, data, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, statePath(workspace.root));
    // Some platforms cannot open or fsync directories. The file itself was
    // synced before the atomic rename; directory syncing is best effort.
    try {
      const directoryDescriptor = openSync(directory, 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch { /* unsupported by this filesystem */ }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  return snapshot;
}

function budget(options: RefreshOptions): { maxFiles: number; maxBytes: number } {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_REFRESH_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REFRESH_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Refresh limits must be positive integers.');
  }
  return { maxFiles, maxBytes };
}

/** Verify all used facts against current bytes. Only a complete scan replaces the snapshot. */
export function refreshIndex(workspace: NanoWorkspace, options: RefreshOptions = {}): RefreshResult {
  const limits = budget(options);
  const discovery = discoverFiles(workspace);
  const previous = readSnapshot(workspace);
  const oldFiles = new Map(previous.snapshot?.files.map((file) => [file.path, file]) ?? []);
  const warnings = [...discovery.warnings];
  if (previous.state === 'corrupt') warnings.push('The Nano index was corrupt or incompatible; current files are being rebuilt.');
  const files: FreshIndexFile[] = [];
  let refreshPartial = discovery.partial;
  let evidencePartial = false;
  let bytes = 0;
  let reused = 0;
  for (const relative of discovery.paths) {
    if (files.length >= limits.maxFiles) { refreshPartial = true; warnings.push('Refresh file limit reached.'); break; }
    try {
      const absolute = safeFile(workspace, relative);
      if (!absolute) throw new Error('unavailable');
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) throw new Error('unavailable');
      if (bytes + stat.size > limits.maxBytes) { refreshPartial = true; warnings.push('Refresh byte limit reached.'); break; }
      const source = readFileSync(absolute, 'utf8');
      bytes += Buffer.byteLength(source, 'utf8');
      const fingerprint = sourceFingerprint(source);
      const old = oldFiles.get(relative);
      const parsed = !options.force && old?.fingerprint === fingerprint && old.size === stat.size ? old.parsed : parseSource(relative, source);
      if (old && parsed === old.parsed) reused++;
      if (parsed.partial) {
        evidencePartial = true;
        if (!warnings.includes('Some source files have syntax errors; declaration evidence is partial.')) warnings.push('Some source files have syntax errors; declaration evidence is partial.');
      }
      files.push({ path: relative, fingerprint, size: stat.size, parsed, source });
    } catch {
      refreshPartial = true;
      if (!warnings.includes('Some source files could not be refreshed.')) warnings.push('Some source files could not be refreshed.');
    }
  }
  const complete = !refreshPartial && files.length === discovery.paths.length;
  let snapshot = previous.snapshot;
  if (complete && options.persist !== false) {
    try { snapshot = writeSnapshot(workspace, files.map(({ source: _source, ...file }) => file)); }
    catch {
      refreshPartial = true;
      warnings.push('The Nano index could not be saved.');
    }
  }
  const partial = refreshPartial || evidencePartial;
  const freshness = partial ? 'partial' : options.persist === false
    ? previous.state === 'corrupt' ? 'corrupt' : previous.state === 'missing' ? 'missing'
      : snapshot?.identity === sha256(JSON.stringify([workspace.root, workspace.scope, files.map((file) => [file.path, file.fingerprint])])) ? 'fresh' : 'stale'
    : 'fresh';
  return {
    files,
    report: {
      schemaVersion: 1,
      command: options.persist === false ? 'nano status' : 'nano index',
      root: workspace.root,
      scope: workspace.scope,
      identity: snapshot?.identity ?? null,
      freshness,
      coverage: { discovered: discovery.paths.length, scanned: files.length, reused, partial },
      exclusions: 'Git ignore, .nanoignore, generated directories, sensitive paths, and symlinks',
      warnings,
    },
  };
}

export function purgeIndex(workspace: NanoWorkspace): NanoIndexReport {
  const directory = path.join(workspace.root, STATE_DIRECTORY);
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Nano state directory is a symlink.');
    rmSync(statePath(workspace.root), { force: true });
    for (const name of readdirSync(directory)) {
      if (/^index-v1\.json\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) rmSync(path.join(directory, name), { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    schemaVersion: 1, command: 'nano purge', root: workspace.root, scope: workspace.scope,
    identity: null, freshness: 'purged', coverage: { discovered: 0, scanned: 0, reused: 0, partial: false },
    exclusions: 'Git ignore, .nanoignore, generated directories, sensitive paths, and symlinks', warnings: [],
  };
}
