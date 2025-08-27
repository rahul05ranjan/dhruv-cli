import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import path from 'path';
import { printError } from '../utils/ux.js';

export async function securityCheck(fileOrDir: string = '.') {
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
      .slice(0, 10); // Limit to 10 files
    
    if (files.length === 0) {
      printError(`No code files found in directory "${fileOrDir}".`);
      return;
    }
    
    for (const f of files) {
      try {
        const filePath = path.join(fileOrDir, f);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        code += `\n// File: ${f}\n${fileContent}\n`;
      } catch (err) {
        console.error(`Error reading file ${f}:`, err);
      }
    }
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
    console.log(chalk.green.bold('🛡️  Security Analysis: '));
    console.log();
    
    const response = await askLangChain({
      prompt: `Perform a security analysis on this code. Look for common security vulnerabilities, unsafe practices, potential injection attacks, and provide recommendations for improvement:\n\n${code}`,
      systemMessage: getSystemMessage('security'),
      model: config.model,
      onToken: (token: string) => {
        process.stdout.write(chalk.cyan(token));
      }
    });

    console.log('\n');
    console.log(chalk.dim('🔧 Need fixes? Try: ') + 
                chalk.cyan('dhruv fix ') + chalk.white('<security issue>'));

  } catch (err) {
    printError('Failed to run security check.');
    
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
