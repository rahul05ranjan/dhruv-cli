import { askLangChain, getSystemMessage } from '../core/langchain-ai.js';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import fs from 'fs';
import { printError, printSuccess } from '../utils/ux.js';

export async function generate(type: string, target: string) {
  const config = loadConfig();
  let content = '';
  
  if (fs.existsSync(target)) {
    content = fs.readFileSync(target, 'utf-8');
  } else {
    printError(`Target file "${target}" does not exist.`);
    return;
  }

  try {
    console.log(chalk.yellowBright('🤖 Dhruv CLI: AI-powered developer assistant'));
    console.log(chalk.green.bold(`🔨 Generating ${type}: `));
    console.log();
    
    let prompt = '';
    if (type === 'tests' || type === 'test') {
      prompt = `Generate comprehensive unit tests for the following JavaScript code. Use Jest or Mocha syntax. Only return the test code without explanations:\n\n${content}`;
    } else if (type === 'documentation' || type === 'docs') {
      prompt = `Generate JSDoc documentation for the following code:\n\n${content}`;
    } else {
      prompt = `Generate ${type} for this code:\n\n${content}`;
    }

    let streamed = '';
    const response = await askLangChain({
      prompt,
      systemMessage: getSystemMessage('generate'),
      model: config.model,
      onToken: (token: string) => {
        streamed += token;
        process.stdout.write(chalk.cyan(token));
      }
    });

    console.log('\n');

    // Handle test generation
    if (type === 'tests' || type === 'test') {
      let codeToSave = streamed;
      
      // Extract code from markdown blocks
      const codeBlockMatch = streamed.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        codeToSave = codeBlockMatch[1].trim();
      } else {
        // Fallback: clean up the response
        codeToSave = streamed
          .replace(/^.*?(?=const|describe|test|it\s*\()/s, '') // Remove text before test code
          .replace(/```[a-z]*\n?/g, '') // Remove code block markers
          .trim();
      }

      const testFile = target.replace(/\.[^.]+$/, '.test.js');
      if (codeToSave) {
        fs.writeFileSync(testFile, codeToSave);
        printSuccess(`Test file saved: ${testFile}`);
      } else {
        printError('No valid test code generated.');
      }
    }

    console.log(chalk.dim('🔍 Want a review? Try: ') + 
                chalk.cyan('dhruv review ') + chalk.white(target));

  } catch (err) {
    printError('Failed to generate code.');
    
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
