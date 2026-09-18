import fs from 'fs';
import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError, printSuccess, printInfo } from '../utils/ux.js';
import { loadConfig } from '../config/config.js';

function buildPrompt(type: string, content: string): string {
  if (type === 'tests' || type === 'test') {
    return `Generate comprehensive unit tests for the following JavaScript code. Use Jest or Mocha syntax. Only return the test code without explanations:\n\n${content}`;
  }
  if (type === 'documentation' || type === 'docs') {
    return `Generate JSDoc documentation for the following code:\n\n${content}`;
  }
  return `Generate ${type} for this code:\n\n${content}`;
}

/** Extracts test code from the response: a fenced block if present, else the raw response. */
function extractTestCode(response: string): string {
  const fenced = response.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  return response
    .replace(/^.*?(?=const|describe|test|it\s*\()/s, '')
    .replace(/```[a-z]*\n?/g, '')
    .trim();
}

export interface GenerateOptions {
  apply?: boolean;
  output?: string;
  overwrite?: boolean;
}

export async function generate(type: string, target: string, options: GenerateOptions = {}) {
  if (!fs.existsSync(target)) {
    printError(`Target file "${target}" does not exist.`);
    return;
  }

  const content = fs.readFileSync(target, 'utf-8');

  await runCommand({
    name: 'generate',
    input: { type, target },
    header: `🔨 Generating ${type}: `,
    buildRequest: (input, model) => ({
      prompt: buildPrompt(input.type, content),
      systemMessage: getSystemMessage('generate'),
      model,
    }),
    onComplete: (response) => {
      if (type !== 'tests' && type !== 'test') return;
      const codeToSave = extractTestCode(response);
      if (!codeToSave) {
        printError('No valid test code generated.');
        return;
      }
      const extension = path.extname(target) || '.js';
      const testFile = options.output ?? target.replace(/\.[^.]+$/, `.test${extension}`);
      if (!options.apply && !options.output) {
        if (loadConfig().responseFormat !== 'json') {
          printInfo(`Preview only. Use --apply to write ${testFile}, or --output <path> to choose a destination.`);
        }
        return;
      }
      if (fs.existsSync(testFile) && !options.overwrite) {
        printError(`Test file "${testFile}" already exists. Use --overwrite to replace it.`);
        return;
      }
      fs.writeFileSync(testFile, codeToSave);
      if (loadConfig().responseFormat !== 'json') printSuccess(`Test file saved: ${testFile}`);
    },
    footer: `🔍 Want a review? Try: dhruv review ${target}`,
  });
}
