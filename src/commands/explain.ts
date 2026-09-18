import { runCommand } from '../core/command-runner.js';
import { getSystemMessage } from '../core/prompts.js';

export async function explain(query: string) {
  await runCommand({
    name: 'explain',
    input: { query },
    header: '📚 Explanation: ',
    buildRequest: (input, model) => ({
      prompt: input.query,
      systemMessage: getSystemMessage('explain'),
      model,
    }),
    footer: `💡 Need more help? Try: dhruv suggest "${query}"`,
  });
}
