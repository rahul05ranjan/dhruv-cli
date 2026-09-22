import { describe, expect, it } from '@jest/globals';
import { completionCommands, queryCommandDefinitions } from '../src/core/command-catalog.js';

describe('query Built-in Command definitions', () => {
  it('exposes command-line, menu, and completion facts from one definition', () => {
    expect(queryCommandDefinitions.map(({ name, description, argument, examples, menuLabel, menuPrompt }) => ({
      name,
      description,
      argument,
      examples,
      menuLabel,
      menuPrompt,
    }))).toEqual([
      {
        name: 'explain',
        description: 'Explain a concept or command',
        argument: { name: 'query', required: true },
        examples: [
          'dhruv explain "What is async/await?"',
          'dhruv explain "Docker containers vs VMs"',
        ],
        menuLabel: 'Explain',
        menuPrompt: 'What would you like me to explain?',
      },
      {
        name: 'suggest',
        description: 'Get AI-powered suggestions',
        argument: { name: 'query', required: true },
        examples: [
          'dhruv suggest "React performance optimization"',
          'dhruv suggest "Node.js project structure"',
        ],
        menuLabel: 'Suggest',
        menuPrompt: 'What would you like suggestions for?',
      },
      {
        name: 'fix',
        description: 'Get a fix for a coding issue or error',
        argument: { name: 'query', required: true },
        examples: [
          'dhruv fix "TypeError: Cannot read property of undefined"',
          'dhruv fix "CORS error in Express.js"',
        ],
        menuLabel: 'Fix',
        menuPrompt: 'Describe the issue you need help fixing:',
      },
    ]);

    expect(completionCommands().split(' ')).toEqual(expect.arrayContaining([
      'explain',
      'suggest',
      'fix',
    ]));
  });
});
