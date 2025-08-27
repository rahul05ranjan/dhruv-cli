import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printError } from '../utils/ux.js';

export async function fix(query: string) {
  if (!query || query.trim().length === 0) {
    printError('Please describe the issue you need help fixing.');
    console.log(chalk.yellow('Example: dhruv fix "TypeError: Cannot read property of undefined"'));
    return;
  }

  const config = loadConfig();
  const spinner = ora('Analyzing issue...').start();
  
  try {
    spinner.stop();
    
    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold('🔧 Fix Analysis: '));
    console.log();
    
    const response = await askLangChain({
      prompt: query,
      systemMessage: getSystemMessage('fix'),
      model: config.model,
      onToken: (token: string) => {
        process.stdout.write(chalk.cyan(token));
      }
    });

    console.log('\n');
    console.log(chalk.dim('🧪 Want to test this? Try: ') + 
                chalk.cyan('dhruv generate tests ') + chalk.white('<your-file>'));
    
  } catch (err) {
    spinner.stop();
    printError('Failed to get fix suggestion.');
    
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
