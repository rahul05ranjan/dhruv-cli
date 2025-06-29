import { askOllama } from '../core/ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import { highlightCode, printError, createProgressBar } from '../utils/ux.js';

export async function review(fileOrDir: string) {
  const config = loadConfig();
  let code = '';
  if (fs.existsSync(fileOrDir)) {
    const stat = fs.statSync(fileOrDir);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fileOrDir);
      const bar = createProgressBar(files.length);
      for (const f of files) {
        code += fs.readFileSync(`${fileOrDir}/${f}`,'utf-8') + '\n';
        bar.increment();
      }
      bar.stop();
    } else {
      code = fs.readFileSync(fileOrDir, 'utf-8');
    }
  }
  let streamed = '';
  try {
    process.stdout.write(chalk.green('Review: '));
    await askOllama({
      prompt: `Review this code:\n${code}`,
      model: config.model,
      onToken: (token: string) => {
        streamed += token;
        process.stdout.write(chalk.cyan(token));
      }
    });
    process.stdout.write('\n');
    if (typeof highlightCode === 'function' && streamed.match(/```[a-z]*[\s\S]*?```/)) {
      const codeBlocks = streamed.match(/```([a-z]*)\n([\s\S]*?)```/g) || [];
      for (const block of codeBlocks) {
        const [, lang, code] = block.match(/```([a-z]*)\n([\s\S]*?)```/) || [];
        if (code) try { console.log(highlightCode(code, lang || 'js')); } catch (err) { console.error('Highlight error:', err); }
      }
    }
  } catch (err) {
    printError('Failed to review code.');
    console.error(chalk.red((err as Error).message));
  }
}
