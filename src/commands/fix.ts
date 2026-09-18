import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';

export async function fix(query: string) {
  await runCommand({
    name: 'fix',
    input: { query },
    header: '🔧 Fix Analysis: ',
    buildRequest: (input, model) => ({
      prompt: input.query,
      systemMessage: getSystemMessage('fix'),
      model,
    }),
    footer: `🧪 Want to test this? Try: dhruv generate tests <your-file>`,
  });
}
