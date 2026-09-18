import fs from 'fs';
import path from 'path';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError, printSuccess, printInfo } from '../utils/ux.js';
import { loadConfig } from '../config/config.js';

function getLanguageForFile(target: string): { name: string; testFramework: string } {
  const ext = path.extname(target).toLowerCase();
  switch (ext) {
    case '.py':
      return { name: 'Python', testFramework: 'pytest or unittest' };
    case '.go':
      return { name: 'Go', testFramework: 'standard testing package' };
    case '.rs':
      return { name: 'Rust', testFramework: 'standard Rust test framework' };
    case '.ts':
    case '.tsx':
      return { name: 'TypeScript', testFramework: 'Jest or Vitest' };
    case '.java':
      return { name: 'Java', testFramework: 'JUnit 5' };
    default:
      return { name: 'JavaScript', testFramework: 'Jest or Mocha' };
  }
}

function buildPrompt(type: string, content: string, target: string): string {
  const lang = getLanguageForFile(target);
  if (type === 'tests' || type === 'test') {
    return `Generate comprehensive unit tests for the following ${lang.name} code. Use ${lang.testFramework} syntax. Only return the test code without explanations:\n\n${content}`;
  }
  if (type === 'documentation' || type === 'docs') {
    return `Generate ${lang.name === 'Python' ? 'docstrings' : 'JSDoc/documentation'} for the following code:\n\n${content}`;
  }
  return `Generate ${type} for this code:\n\n${content}`;
}

/** Extracts test code from the response: a fenced block if present, else the raw response. */
function extractTestCode(response: string): string {
  const fenced = response.match(/```(?:javascript|js|typescript|ts|python|py|go|rust|rs|java)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return response
    .replace(/^.*?(?=const|describe|test|it\s*\(|def test_|func Test|#\[test\])/s, '')
    .replace(/```[a-z]*\n?/gi, '')
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
      prompt: buildPrompt(input.type, content, input.target),
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
