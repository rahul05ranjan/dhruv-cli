import type { BuiltInCommand } from '../built-in-commands.js';
import { explain } from '../explain.js';
import { suggest } from '../suggest.js';
import { fix } from '../fix.js';

/** Straightforward query commands: one free-text query, answered by the AI. */
export const queryCommands: readonly BuiltInCommand[] = [
  {
    name: 'explain',
    description: 'Explain a concept or command',
    menuLabel: 'Explain',
    arguments: [{ name: 'query', required: true, menuPrompt: 'What would you like me to explain?' }],
    examples: ['dhruv explain "What is async/await?"', 'dhruv explain "Docker containers vs VMs"'],
    run: ({ query = '' }) => explain(query),
  },
  {
    name: 'suggest',
    description: 'Get AI-powered suggestions',
    menuLabel: 'Suggest',
    arguments: [{ name: 'query', required: true, menuPrompt: 'What would you like suggestions for?' }],
    examples: ['dhruv suggest "React performance optimization"', 'dhruv suggest "Node.js project structure"'],
    run: ({ query = '' }) => suggest(query),
  },
  {
    name: 'fix',
    description: 'Get a fix for a coding issue or error',
    menuLabel: 'Fix',
    arguments: [{ name: 'query', required: true, menuPrompt: 'Describe the issue you need help fixing:' }],
    examples: ['dhruv fix "TypeError: Cannot read property of undefined"', 'dhruv fix "CORS error in Express.js"'],
    run: ({ query = '' }) => fix(query),
  },
];
