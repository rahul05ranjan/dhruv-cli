import { askOllama } from '../core/ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import { highlightCode, printError } from '../utils/ux.js';

export async function securityCheck(fileOrDir: string = '.') {
  const config = loadConfig();
  let code = '';
  if (fs.existsSync(fileOrDir)) {
    const stat = fs.statSync(fileOrDir);
    if (stat.isDirectory()) {
      code = fs.readdirSync(fileOrDir).map(f => fs.readFileSync(`${fileOrDir}/${f}`,'utf-8')).join('\n');
    } else {
      code = fs.readFileSync(fileOrDir, 'utf-8');
    }
  }
  let streamed = '';
  try {
    process.stdout.write(chalk.green('Security check result: '));
    await askOllama({
      prompt: `Security check for this code:\n${code}`,
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
    printError('Failed to run security check.');
    console.error(chalk.red((err as Error).message));
  }
}
