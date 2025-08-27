import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import path from 'path';
import { printError, createProgressBar } from '../utils/ux.js';

export async function review(fileOrDir: string) {
  const config = loadConfig();
  let code = '';
  
  if (!fs.existsSync(fileOrDir)) {
    printError(`Path "${fileOrDir}" does not exist.`);
    return;
  }

  const stat = fs.statSync(fileOrDir);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(fileOrDir)
      .filter(f => f.match(/\.(js|ts|jsx|tsx|py|java|cpp|c|go|rs|rb|php)$/))
      .slice(0, 10); // Limit to 10 files to avoid overwhelming the AI
    
    if (files.length === 0) {
      printError(`No code files found in directory "${fileOrDir}".`);
      return;
    }
    
    const bar = createProgressBar(files.length);
    for (const f of files) {
      try {
        const filePath = path.join(fileOrDir, f);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        code += `\n// File: ${f}\n${fileContent}\n`;
        bar.increment();
      } catch (err) {
        console.error(`Error reading file ${f}:`, err);
      }
    }
    bar.stop();
  } else {
    try {
      code = fs.readFileSync(fileOrDir, 'utf-8');
    } catch (err) {
      printError(`Error reading file "${fileOrDir}": ${(err as Error).message}`);
      return;
    }
  }

  try {
    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold('🔍 Code Review: '));
    console.log();
    
    const _response = await askLangChain({
      prompt: `Please review this code and provide feedback on code quality, best practices, potential issues, and suggestions for improvement. Here is the code to review:

CODE_START
${code}
CODE_END

Please provide your review in a structured format with clear categories and actionable feedback.`,
      systemMessage: 'You are a senior code reviewer focused on code quality, best practices, and maintainability. Provide constructive feedback in a structured format.',
      model: config.model,
      onToken: (token: string) => {
        process.stdout.write(chalk.cyan(token));
      }
    });
    
    console.log('\n');
    console.log(chalk.dim('🛡️  Security check? Try: ') + 
                chalk.cyan('dhruv security-check ') + chalk.white(fileOrDir));
    
  } catch (err) {
    printError('Failed to review code.');
    
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
