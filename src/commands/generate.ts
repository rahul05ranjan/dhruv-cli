import { askOllama } from '../core/ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import { highlightCode, printError, printSuccess } from '../utils/ux.js';

export async function generate(type: string, target: string) {
  const config = loadConfig();
  let content = '';
  if (fs.existsSync(target)) {
    content = fs.readFileSync(target, 'utf-8');
  }
  let streamed = '';
  try {
    process.stdout.write(chalk.green('Generated code: '));
    await askOllama({
      prompt: `Generate only a valid JavaScript ${type} file for this code, no explanations, no Markdown, just the code.\n${content}`,
      model: config.model,
      onToken: (token: string) => {
        streamed += token;
        process.stdout.write(chalk.cyan(token));
      }
    });
    process.stdout.write('\n');
    // Robust code extraction for tests
    let codeToSave = streamed;
    if (type === 'tests' && target && typeof streamed === 'string') {
      const codeBlockMatch = streamed.match(/```(?:[a-z]*)?\n([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        codeToSave = codeBlockMatch[1].trim();
      } else {
        // Remove Markdown, explanations, and keep only lines that look like code
        codeToSave = streamed
          .replace(/```[a-z]*\n|```/g, '') // remove code block markers
          .split('\n')
          .filter(line => line.trim() && !/^\s*#|^\s*\/\//.test(line) && /[;{}()=]/.test(line))
          .join('\n')
          .trim();
      }
      const testFile = target.replace(/\.[^.]+$/, '.test.js');
      fs.writeFileSync(testFile, codeToSave);
      printSuccess(`Test file saved: ${testFile}`);
    }
    if (typeof highlightCode === 'function' && streamed.match(/```[a-z]*[\s\S]*?```/)) {
      const codeBlocks = streamed.match(/```([a-z]*)\n([\s\S]*?)```/g) || [];
      for (const block of codeBlocks) {
        const [, lang, code] = block.match(/```([a-z]*)\n([\s\S]*?)```/) || [];
        if (code) try { console.log(highlightCode(code, lang || 'js')); } catch {}
      }
    }
  } catch (err) {
    printError('Failed to generate code.');
    console.error(chalk.red((err as Error).message));
  }
}
