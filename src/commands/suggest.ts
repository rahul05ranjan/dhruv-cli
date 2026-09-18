import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';

export async function suggest(query: string) {
  await runCommand({
    name: 'suggest',
    input: { query },
    header: '💡 Suggestions: ',
    buildRequest: (input, model) => ({
      prompt: input.query,
      systemMessage: getSystemMessage('suggest'),
      model,
    }),
    footer: `🔧 Need implementation help? Try: dhruv fix "${query}"`,
  });
}
