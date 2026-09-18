import fs from 'fs';
import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';
import { printError, printSuccess } from '../utils/ux.js';

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

export async function generate(type: string, target: string) {
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
      const testFile = target.replace(/\.[^.]+$/, '.test.js');
      fs.writeFileSync(testFile, codeToSave);
      printSuccess(`Test file saved: ${testFile}`);
    },
    footer: `🔍 Want a review? Try: dhruv review ${target}`,
  });
}
