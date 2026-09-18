import fs from 'fs';
import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError } from '../utils/ux.js';

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

function redactSensitiveContent(content: string): string {
  return content
    .replace(/(\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["'`])[^"'`\r\n]+(["'`])/gi, '$1[REDACTED]$2')
    .replace(/\b(?:sk|pk)-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/-----BEGIN (?:RSA|OPENSSH|EC|PGP|DSA)? PRIVATE KEY-----[\s\S]*?-----END (?:RSA|OPENSSH|EC|PGP|DSA)? PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

interface SecurityFinding {
  line: number;
  severity: 'high';
  description: string;
  remediation: string;
}

function findHighConfidenceFindings(content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (/\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["'`][^"'`\r\n]+["'`]/i.test(line)) {
      findings.push({
        line: index + 1,
        severity: 'high',
        description: 'credential-like value assigned in source',
        remediation: 'rotate the credential and load it from a secret manager or environment variable',
      });
    } else if (/\b(?:sk|pk)-[a-z0-9_-]{8,}\b/i.test(line)) {
      findings.push({
        line: index + 1,
        severity: 'high',
        description: 'credential-like API key detected',
        remediation: 'rotate the credential and remove it from source control',
      });
    } else if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(line)) {
      findings.push({
        line: index + 1,
        severity: 'high',
        description: 'bearer token detected',
        remediation: 'revoke the token and use a secure runtime secret store',
      });
    } else if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/.test(line)) {
      findings.push({
        line: index + 1,
        severity: 'high',
        description: 'GitHub token detected',
        remediation: 'revoke the GitHub token and store it in GitHub Secrets or environment variables',
      });
    } else if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) {
      findings.push({
        line: index + 1,
        severity: 'high',
        description: 'AWS access key ID detected',
        remediation: 'rotate the AWS access key and use IAM roles or AWS Secrets Manager',
      });
    }
  });

  return findings;
}

export interface SecurityCheckOptions {
  strict?: boolean;
}

/** Reads a file or the code files of a directory (up to 10), concatenated. */
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

export async function securityCheck(fileOrDir: string = '.', options: SecurityCheckOptions = {}) {
  const code = readCode(fileOrDir);
  if (code === undefined) return;
  const findings = findHighConfidenceFindings(code);
  const safeCode = redactSensitiveContent(code);
  const findingSummary = findings.length === 0
    ? 'none'
    : findings.map((finding) => `- ${finding.severity} at line ${finding.line}: ${finding.description}; remediation: ${finding.remediation}`).join('\n');

  if (options.strict && findings.length > 0) {
    process.exitCode = 1;
  }

  await runCommand({
    name: 'security-check',
    input: { fileOrDir },
    header: '🛡️  Security Analysis: ',
    buildRequest: (input, model) => ({
      prompt: `Perform a security analysis on this code. Look for common security vulnerabilities, unsafe practices, potential injection attacks, and provide recommendations for improvement. High-confidence pre-scan findings:\n${findingSummary}\n\n${safeCode}`,
      systemMessage: getSystemMessage('security'),
      model,
    }),
    footer: `🔧 Need fixes? Try: dhruv fix <security issue>`,
  });
}
