import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { loadSource } from '../core/source-bundle.js';

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
  file: string;
  line: number;
  severity: 'high';
  description: string;
  remediation: string;
}

function findHighConfidenceFindings(content: string, filePath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (/\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["'`][^"'`\r\n]+["'`]/i.test(line)) {
      findings.push({
        file: filePath,
        line: index + 1,
        severity: 'high',
        description: 'credential-like value assigned in source',
        remediation: 'rotate the credential and load it from a secret manager or environment variable',
      });
    } else if (/\b(?:sk|pk)-[a-z0-9_-]{8,}\b/i.test(line)) {
      findings.push({
        file: filePath,
        line: index + 1,
        severity: 'high',
        description: 'credential-like API key detected',
        remediation: 'rotate the credential and remove it from source control',
      });
    } else if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(line)) {
      findings.push({
        file: filePath,
        line: index + 1,
        severity: 'high',
        description: 'bearer token detected',
        remediation: 'revoke the token and use a secure runtime secret store',
      });
    } else if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/.test(line)) {
      findings.push({
        file: filePath,
        line: index + 1,
        severity: 'high',
        description: 'GitHub token detected',
        remediation: 'revoke the GitHub token and store it in GitHub Secrets or environment variables',
      });
    } else if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) {
      findings.push({
        file: filePath,
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

export async function securityCheck(fileOrDir: string = '.', options: SecurityCheckOptions = {}) {
  const bundle = loadSource(fileOrDir);
  if (!bundle) return;

  const findings: SecurityFinding[] = [];
  for (const file of bundle.files) {
    findings.push(...findHighConfidenceFindings(file.content, file.path));
  }

  const safeCode = redactSensitiveContent(bundle.promptContent);
  const findingSummary = findings.length === 0
    ? 'none'
    : findings.map((finding) => `- ${finding.severity} in ${finding.file} at line ${finding.line}: ${finding.description}; remediation: ${finding.remediation}`).join('\n');

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

