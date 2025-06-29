import { askOllama } from '../core/ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { highlightCode, printError } from '../utils/ux.js';

export async function suggest(query: string) {
  const config = loadConfig();
  const spinner = ora('Generating suggestions...').start();
  let streamed = '';
  try {
    spinner.stop();
    process.stdout.write(chalk.green('Suggestions: '));
    await askOllama({
      prompt: `Suggest: ${query}`,
      model: config.model,
      onToken: (token: string) => {
        streamed += token;
        process.stdout.write(chalk.cyan(token));
      }
    });
    process.stdout.write('\n');
    if (typeof highlightCode === 'function' && streamed.match(/```[a-z]*[\s\S]*?```/)) {
      // Highlight code blocks if present
      const codeBlocks = streamed.match(/```([a-z]*)\n([\s\S]*?)```/g) || [];
      for (const block of codeBlocks) {
        const [, lang, code] = block.match(/```([a-z]*)\n([\s\S]*?)```/) || [];
        if (code) try { console.log(highlightCode(code, lang || 'js')); } catch {}
      }
    }
  } catch (err) {
    printError('Failed to get suggestions.');
    console.error(chalk.red((err as Error).message));
  }
}
