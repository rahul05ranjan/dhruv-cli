import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export const CODE_FILE = /\.(js|ts|jsx|tsx|py|java|cpp|c|go|rs|rb|php)$/;

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.dhruv-cache',
  'logs',
  '.next',
  '.turbo',
  '__pycache__',
  '.pytest_cache',
  'target',
  'vendor',
]);

export interface SourceFile {
  path: string;
  content: string;
}

export interface SourceBundle {
  target: string;
  files: SourceFile[];
  isDiff: boolean;
  capped: boolean;
  promptContent: string;
  maxFiles?: number;
}

export type SourceFailureReason =
  | 'not-found'
  | 'unsupported-target'
  | 'no-code-files'
  | 'empty-diff'
  | 'diff-error';

export interface SourceSuccessOutcome extends SourceBundle {
  ok: true;
}

export interface SourceFailureOutcome {
  ok: false;
  target: string;
  reason: SourceFailureReason;
  message: string;
}

export type SourceOutcome = SourceSuccessOutcome | SourceFailureOutcome;

export interface IngestSourceOptions {
  diff?: boolean;
  maxFiles?: number;
}

export type LoadSourceOptions = IngestSourceOptions;

export function ingestSource(target: string, options: IngestSourceOptions = {}): SourceOutcome {
  if (options.diff) {
    return ingestGitDiff(target);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return {
      ok: false,
      target,
      reason: 'not-found',
      message: `Path "${target}" does not exist or could not be read.`,
    };
  }

  if (stat.isFile()) {
    return ingestSingleFile(target);
  }

  if (stat.isDirectory()) {
    return ingestDirectory(target, options.maxFiles ?? 10);
  }

  return {
    ok: false,
    target,
    reason: 'unsupported-target',
    message: `Path "${target}" is neither a file nor a directory.`,
  };
}

function ingestSingleFile(target: string): SourceOutcome {
  try {
    const content = fs.readFileSync(target, 'utf-8');
    const relativePath = path.basename(target);
    return {
      ok: true,
      target,
      files: [{ path: relativePath, content }],
      isDiff: false,
      capped: false,
      promptContent: content,
    };
  } catch {
    return {
      ok: false,
      target,
      reason: 'not-found',
      message: `Path "${target}" does not exist or could not be read.`,
    };
  }
}

function ingestDirectory(dir: string, maxFiles: number): SourceOutcome {
  const collectedFiles: SourceFile[] = [];
  let capped = false;

  function collect(current: string): void {
    if (collectedFiles.length >= maxFiles) {
      capped = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (collectedFiles.length >= maxFiles) {
        capped = true;
        return;
      }

      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          collect(absolute);
        }
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        try {
          const content = fs.readFileSync(absolute, 'utf-8');
          const relPath = path.relative(dir, absolute).split(path.sep).join('/');
          collectedFiles.push({ path: relPath, content });
        } catch {
          // ignore unreadable file
        }
      }
    }
  }

  collect(dir);

  if (collectedFiles.length === 0) {
    return {
      ok: false,
      target: dir,
      reason: 'no-code-files',
      message: `No code files found in directory "${dir}".`,
    };
  }

  let promptContent = '';
  for (const f of collectedFiles) {
    promptContent += `\n// File: ${f.path}\n${f.content}\n`;
  }

  return {
    ok: true,
    target: dir,
    files: collectedFiles,
    isDiff: false,
    capped,
    maxFiles,
    promptContent,
  };
}

function ingestGitDiff(fileOrDir: string): SourceOutcome {
  const root = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  try {
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=80', '--'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (!diff.trim()) {
      return {
        ok: false,
        target: fileOrDir,
        reason: 'empty-diff',
        message: `No uncommitted changes found in "${fileOrDir}".`,
      };
    }

    return {
      ok: true,
      target: fileOrDir,
      files: [],
      isDiff: true,
      capped: false,
      promptContent: diff,
    };
  } catch {
    return {
      ok: false,
      target: fileOrDir,
      reason: 'diff-error',
      message: `Could not read a git diff for "${fileOrDir}".`,
    };
  }
}
