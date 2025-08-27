import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import path from 'path';
import { printError } from '../utils/ux.js';

export async function optimize(file: string) {
  if (!file || file.trim().length === 0) {
    printError('Please provide a file path to optimize.');
    console.log(chalk.yellow('Example: dhruv optimize package.json'));
    return;
  }

  const config = loadConfig();
  let content = '';
  
  if (!fs.existsSync(file)) {
    printError(`File "${file}" does not exist.`);
    return;
  }

  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    printError(`Error reading file "${file}": ${(err as Error).message}`);
    return;
  }

  // Detect file type for better optimization prompts
  const ext = path.extname(file).toLowerCase();
  const fileName = path.basename(file);
  
  let optimizationType = 'general code';
  if (fileName === 'package.json') {
    optimizationType = 'package.json configuration';
  } else if (ext === '.js' || ext === '.ts') {
    optimizationType = 'JavaScript/TypeScript code';
  } else if (ext === '.json') {
    optimizationType = 'JSON configuration';
  } else if (ext === '.css') {
    optimizationType = 'CSS styles';
  } else if (ext === '.html') {
    optimizationType = 'HTML markup';
  }

  try {
    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold(`⚡ Optimization suggestions for ${optimizationType}: `));
    console.log();
    
    const prompt = `Please analyze and provide optimization suggestions for this ${optimizationType}:

${content}

Please provide:
1. Specific optimization recommendations
2. Performance improvements
3. Best practices to implement
4. Code examples of improvements
5. Potential issues to fix

Focus on actionable, practical improvements.`;

    const response = await askLangChain({
      prompt,
      systemMessage: getSystemMessage('optimize'),
      model: config.model,
      onToken: (token: string) => {
        process.stdout.write(chalk.cyan(token));
      }
    });

    console.log('\n');
    console.log(chalk.dim('🔍 Want a code review? Try: ') + 
                chalk.cyan('dhruv review ') + chalk.white(file));

  } catch (err) {
    printError('Failed to optimize.');
    
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
