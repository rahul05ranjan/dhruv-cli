import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printError } from '../utils/ux.js';

export async function suggest(query: string) {
  if (!query || query.trim().length === 0) {
    printError('Please provide a topic for suggestions.');
    console.log(chalk.yellow('Example: dhruv suggest "React performance optimization"'));
    return;
  }

  const config = loadConfig();
  const spinner = ora('Generating suggestions...').start();
  
  try {
    spinner.stop();
    
    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold('💡 Suggestions: '));
    console.log();
    
    const _response = await askLangChain({
      prompt: query,
      systemMessage: getSystemMessage('suggest'),
      model: config.model,
      onToken: (token: string) => {
        process.stdout.write(chalk.cyan(token));
      }
    });

    console.log('\n');
    console.log(chalk.dim('🔧 Need implementation help? Try: ') + 
                chalk.cyan('dhruv fix "') + chalk.white(query) + chalk.cyan('"'));
    
  } catch (err) {
    spinner.stop();
    printError('Failed to get suggestions.');
    
    const errorMessage = (err as Error).message;
    if (errorMessage.includes('Ollama is not running')) {
      console.log(chalk.yellow('💡 Make sure Ollama is running: ') + chalk.cyan('ollama serve'));
    } else if (errorMessage.includes('not found')) {
      console.log(chalk.yellow('💡 Install the model: ') + chalk.cyan(`ollama pull ${config.model}`));
    } else {
      console.error(chalk.red(errorMessage));
    }
  }
}
