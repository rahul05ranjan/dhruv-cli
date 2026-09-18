import fs from 'fs';
import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError } from '../utils/ux.js';

/** Reads a file or the code files of a directory (up to 10), concatenated. */
function readCode(fileOrDir: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fileOrDir);
  } catch {
    printError(`Path "${fileOrDir}" does not exist.`);
    return undefined;
  }

  if (!stat.isDirectory()) {
    try {
      return fs.readFileSync(fileOrDir, 'utf-8');
    } catch (err) {
      printError(`Error reading file "${fileOrDir}": ${(err as Error).message}`);
      return undefined;
    }
  }

  const files = fs
    .readdirSync(fileOrDir)
    .filter((f) => f.match(/\.(js|ts|jsx|tsx|py|java|cpp|c|go|rs|rb|php)$/))
    .slice(0, 10);

  if (files.length === 0) {
    printError(`No code files found in directory "${fileOrDir}".`);
    return undefined;
  }

  let code = '';
  for (const f of files) {
    try {
      code += `\n// File: ${f}\n${fs.readFileSync(path.join(fileOrDir, f), 'utf-8')}\n`;
    } catch (err) {
      console.error(`Error reading file ${f}:`, err);
    }
  }
  return code;
}

export async function securityCheck(fileOrDir: string = '.') {
  const code = readCode(fileOrDir);
  if (code === undefined) return;

  await runCommand({
    name: 'security-check',
    input: { fileOrDir },
    header: '🛡️  Security Analysis: ',
    buildRequest: (input, model) => ({
      prompt: `Perform a security analysis on this code. Look for common security vulnerabilities, unsafe practices, potential injection attacks, and provide recommendations for improvement:\n\n${code}`,
      systemMessage: getSystemMessage('security'),
      model,
    }),
    footer: `🔧 Need fixes? Try: dhruv fix <security issue>`,
  });
}
