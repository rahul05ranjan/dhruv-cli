import fs from 'fs';
import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { detectProjectType } from '../utils/projectType.js';
import { ingestSource } from '../core/source-ingestion.js';
import { presentSourceOutcome } from '../core/command-presentation.js';

export interface ReviewOptions {
  diff?: boolean;
}

export async function review(fileOrDir: string, options: ReviewOptions = {}) {
  const outcome = ingestSource(fileOrDir, { diff: options.diff });
  if (!presentSourceOutcome('review', outcome)) return;

  const projectRoot = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  const projectType = detectProjectType(projectRoot);
  const scope = outcome.isDiff ? 'the current uncommitted git diff' : 'the supplied source files';

  await runCommand({
    name: 'review',
    input: { fileOrDir },
    header: '🔍 Code Review: ',
    buildRequest: (input, model) => ({
      prompt: `Please review ${scope} for a ${projectType} project. Provide feedback on code quality, best practices, potential issues, and suggestions for improvement. For every finding, include the file, line or region, severity, explanation, and an actionable recommendation. Here is the code to review:\n\nCODE_START\n${outcome.promptContent}\nCODE_END`,
      systemMessage: getSystemMessage('review'),
      model,
    }),
    footer: `🛡️  Security check? Try: dhruv security-check ${fileOrDir}`,
  });
}
