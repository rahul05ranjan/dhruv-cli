import { askOllama } from '../core/ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { highlightCode, printError } from '../utils/ux.js';

export async function explain(query: string) {
  const config = loadConfig();
  const spinner = ora('Thinking...').start();
  let streamed = '';
  const dhruvIntro = chalk.yellowBright('Dhruv CLI: Your AI-powered CLI assistant for developers using Ollama.\n');
  try {
    spinner.stop();
    process.stdout.write(dhruvIntro); // Print Dhruv intro before explanation
    process.stdout.write(chalk.green('Explanation: '));
    await askOllama({
      prompt: `Explain: ${query}`,
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
        if (code) {
          try {
            console.log(highlightCode(code, lang || 'js'));
          } catch (err) {
            // Only log highlight errors in development
            if (process.env.NODE_ENV === 'development') {
              console.error('Highlight error:', err);
            }
          }
        }
      }
    }
  } catch (err) {
    printError('Failed to get explanation.');
    console.error(chalk.red((err as Error).message));
  }
}
