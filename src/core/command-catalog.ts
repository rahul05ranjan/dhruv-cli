export interface CommandCatalogEntry {
  name: string;
  description: string;
  menuLabel: string;
  options?: string[];
}

export const commandCatalog: CommandCatalogEntry[] = [
  { name: 'explain', description: 'Explain a concept or command', menuLabel: 'Explain' },
  { name: 'suggest', description: 'Get AI-powered suggestions', menuLabel: 'Suggest' },
  { name: 'fix', description: 'Get a fix for a coding issue or error', menuLabel: 'Fix' },
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
