import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError, printInfo } from '../utils/ux.js';
import { detectProjectType } from '../utils/projectType.js';

const CODE_FILE = /\.(js|ts|jsx|tsx|py|java|cpp|c|go|rs|rb|php)$/;
const IGNORED_DIRECTORIES = new Set([
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

/** Reads a file or up to 10 code files from a directory tree. */
function readCode(fileOrDir: string): string | undefined {
  // Read first, branch on the error: no separate existence check to race against.
  let content: string;
  try {
    content = fs.readFileSync(fileOrDir, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') {
      return readDirectory(fileOrDir);
    }
    printError(`Path "${fileOrDir}" does not exist or could not be read.`);
    return undefined;
  }
  return content;
}

function readDirectory(dir: string): string | undefined {
  const files: string[] = [];

  function collect(current: string): void {
    if (files.length >= 10) return;

    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 10) return;
      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) collect(absolute);
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        files.push(path.relative(dir, absolute).split(path.sep).join('/'));
      }
    }
  }

  collect(dir);

  if (files.length === 0) {
    printError(`No code files found in directory "${dir}".`);
    return undefined;
  }

  if (files.length >= 10) {
    printInfo('Note: Directory review is capped at the first 10 source files.');
  }

  let code = '';
  for (const f of files) {
    try {
      code += `\n// File: ${f}\n${fs.readFileSync(path.join(dir, f), 'utf-8')}\n`;
    } catch (err) {
      console.error(`Error reading file ${f}:`, err);
    }
  }
  return code;
}

function readGitDiff(fileOrDir: string): string | undefined {
  const root = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  try {
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=80', '--'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!diff.trim()) {
      printError(`No uncommitted changes found in "${fileOrDir}".`);
      return undefined;
    }
    return diff;
  } catch {
    printError(`Could not read a git diff for "${fileOrDir}".`);
    return undefined;
  }
}

export interface ReviewOptions {
  diff?: boolean;
}

export async function review(fileOrDir: string, options: ReviewOptions = {}) {
  const code = options.diff ? readGitDiff(fileOrDir) : readCode(fileOrDir);
  if (code === undefined) return;
  const projectRoot = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  const projectType = detectProjectType(projectRoot);
  const scope = options.diff ? 'the current uncommitted git diff' : 'the supplied source files';

  await runCommand({
    name: 'review',
    input: { fileOrDir },
    header: '🔍 Code Review: ',
    buildRequest: (input, model) => ({
      prompt: `Please review ${scope} for a ${projectType} project. Provide feedback on code quality, best practices, potential issues, and suggestions for improvement. For every finding, include the file, line or region, severity, explanation, and an actionable recommendation. Here is the code to review:\n\nCODE_START\n${code}\nCODE_END`,
      systemMessage: getSystemMessage('review'),
      model,
    }),
    footer: `🛡️  Security check? Try: dhruv security-check ${fileOrDir}`,
  });
}
