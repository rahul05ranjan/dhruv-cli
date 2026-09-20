import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { printError, printInfo } from '../utils/ux.js';

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
}

export interface LoadSourceOptions {
  diff?: boolean;
  maxFiles?: number;
}

export function loadSource(target: string, options: LoadSourceOptions = {}): SourceBundle | null {
  if (options.diff) {
    return loadGitDiff(target);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    printError(`Path "${target}" does not exist or could not be read.`);
    process.exitCode = 1;
    return null;
  }

  if (stat.isFile()) {
    return loadSingleFile(target);
  }

  if (stat.isDirectory()) {
    return loadDirectory(target, options.maxFiles ?? 10);
  }

  printError(`Path "${target}" is neither a file nor a directory.`);
  process.exitCode = 1;
  return null;
}

function loadSingleFile(target: string): SourceBundle | null {
  try {
    const content = fs.readFileSync(target, 'utf-8');
    const relativePath = path.basename(target);
    return {
      target,
      files: [{ path: relativePath, content }],
      isDiff: false,
      capped: false,
      promptContent: content,
    };
  } catch {
    printError(`Path "${target}" does not exist or could not be read.`);
    process.exitCode = 1;
    return null;
  }
}

function loadDirectory(dir: string, maxFiles: number): SourceBundle | null {
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
    printError(`No code files found in directory "${dir}".`);
    process.exitCode = 1;
    return null;
  }

  if (capped) {
    printInfo(`Note: Directory review is capped at the first ${maxFiles} source files.`);
  }

  let promptContent = '';
  for (const f of collectedFiles) {
    promptContent += `\n// File: ${f.path}\n${f.content}\n`;
  }

  return {
    target: dir,
    files: collectedFiles,
    isDiff: false,
    capped,
    promptContent,
  };
}

function loadGitDiff(fileOrDir: string): SourceBundle | null {
  const root = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  try {
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=80', '--'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (!diff.trim()) {
      printError(`No uncommitted changes found in "${fileOrDir}".`);
      process.exitCode = 1;
      return null;
    }

    return {
      target: fileOrDir,
      files: [],
      isDiff: true,
      capped: false,
      promptContent: diff,
    };
  } catch {
    printError(`Could not read a git diff for "${fileOrDir}".`);
    process.exitCode = 1;
    return null;
  }
}
