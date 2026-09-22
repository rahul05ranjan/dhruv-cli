export interface CommandCatalogEntry {
  name: string;
  description: string;
  menuLabel: string;
  options?: readonly string[];
}

export interface QueryCommandDefinition extends CommandCatalogEntry {
  argument: { name: string; required: boolean };
  examples: readonly string[];
  menuPrompt: string;
  action: (query: string) => Promise<void>;
}

export const queryCommandDefinitions: readonly QueryCommandDefinition[] = [
  {
    name: 'explain',
    description: 'Explain a concept or command',
    menuLabel: 'Explain',
    argument: { name: 'query', required: true },
    examples: [
      'dhruv explain "What is async/await?"',
      'dhruv explain "Docker containers vs VMs"',
    ],
    menuPrompt: 'What would you like me to explain?',
    action: async (query) => (await import('../commands/explain.js')).explain(query),
  },
  {
    name: 'suggest',
    description: 'Get AI-powered suggestions',
    menuLabel: 'Suggest',
    argument: { name: 'query', required: true },
    examples: [
      'dhruv suggest "React performance optimization"',
      'dhruv suggest "Node.js project structure"',
    ],
    menuPrompt: 'What would you like suggestions for?',
    action: async (query) => (await import('../commands/suggest.js')).suggest(query),
  },
  {
    name: 'fix',
    description: 'Get a fix for a coding issue or error',
    menuLabel: 'Fix',
    argument: { name: 'query', required: true },
    examples: [
      'dhruv fix "TypeError: Cannot read property of undefined"',
      'dhruv fix "CORS error in Express.js"',
    ],
    menuPrompt: 'Describe the issue you need help fixing:',
    action: async (query) => (await import('../commands/fix.js')).fix(query),
  },
];

const remainingCommandCatalog: readonly CommandCatalogEntry[] = [
  { name: 'review', description: 'Review code in a file or directory', menuLabel: 'Review', options: ['--diff'] },
  { name: 'optimize', description: 'Optimize a file (e.g., package.json)', menuLabel: 'Optimize' },
  { name: 'security-check', description: 'Run a security check on code', menuLabel: 'Security Check', options: ['--strict'] },
  { name: 'generate', description: 'Generate code/tests for a file', menuLabel: 'Generate', options: ['--apply', '--output', '--overwrite'] },
  { name: 'init', description: 'Interactive setup/configuration wizard', menuLabel: 'Init (Setup)' },
  { name: 'status', description: 'Check Ollama connection and available models', menuLabel: 'Status' },
  { name: 'health', description: 'Run comprehensive health check', menuLabel: 'Health Check', options: ['--details'] },
  { name: 'metrics', description: 'Display CLI usage metrics', menuLabel: 'Metrics', options: ['--raw', '--reset'] },
  { name: 'project-type', description: 'Detect and print the current project type', menuLabel: 'Project Type' },
  { name: 'menu', description: 'Interactive command palette', menuLabel: 'Menu' },
  { name: 'completion', description: 'Generate shell completion script', menuLabel: 'Shell Completion' },
];

export const commandCatalog: readonly CommandCatalogEntry[] = [
  ...queryCommandDefinitions,
  ...remainingCommandCatalog,
];

export function commandDescription(name: string): string {
  return commandCatalog.find((command) => command.name === name)?.description ?? name;
}

export function completionCommands(): string {
  return commandCatalog.map((command) => command.name).join(' ');
}

export function completionOptions(): string {
  const options = new Set(['--help', '--version', '--model', '--verbose', '--json', '--timeout']);
  commandCatalog.forEach((command) => command.options?.forEach((option) => options.add(option)));
  return [...options].join(' ');
}
