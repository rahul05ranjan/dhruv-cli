import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError } from '../utils/ux.js';
import { loadSource } from '../core/source-bundle.js';

function optimizationType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const fileName = path.basename(file);
  if (fileName === 'package.json') return 'package.json configuration';
  if (ext === '.js' || ext === '.ts') return 'JavaScript/TypeScript code';
  if (ext === '.json') return 'JSON configuration';
  if (ext === '.css') return 'CSS styles';
  if (ext === '.html') return 'HTML markup';
  return 'general code';
}

export async function optimize(file: string) {
  if (!file || file.trim().length === 0) {
    printError('Please provide a file path to optimize.');
    process.exitCode = 1;
    return;
  }

  const bundle = loadSource(file);
  if (!bundle) return;

  const content = bundle.promptContent;
  const type = optimizationType(file);
  await runCommand({
    name: 'optimize',
    input: { file },
    header: `⚡ Optimization suggestions for ${type}: `,
    buildRequest: (input, model) => ({
      prompt: `Please analyze and provide optimization suggestions for this ${type}. For every recommendation, explain the expected impact, how to measure it, and the trade-offs or risks before applying it.\n\n${content}\n\nPlease provide:\n1. Specific optimization recommendations\n2. Performance improvements\n3. Best practices to implement\n4. Code examples of improvements\n5. Potential issues to fix\n\nFocus on actionable, practical improvements.`,
      systemMessage: getSystemMessage('optimize'),
      model,
    }),
    footer: `🔍 Want a code review? Try: dhruv review ${file}`,
  });
}

