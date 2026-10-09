export const nanoCommands = ['context', 'index', 'status', 'purge'] as const;
export type NanoCommandName = typeof nanoCommands[number];

interface NanoOption {
  flag: string;
  description: string;
  valueName?: string;
}

const common: NanoOption[] = [
  { flag: '--json', description: 'Emit one versioned JSON response' },
  { flag: '--root', valueName: 'path', description: 'Workspace root (defaults to the containing Git repository)' },
  { flag: '--scope', valueName: 'path', description: 'Limit results to a directory inside the workspace root' },
];
const refreshLimits: NanoOption[] = [
  { flag: '--max-refresh-files', valueName: 'count', description: 'Maximum files verified during refresh' },
  { flag: '--max-refresh-bytes', valueName: 'count', description: 'Maximum source bytes read during refresh' },
];

export const nanoCommandOptions: Record<NanoCommandName, NanoOption[]> = {
  context: [
    ...common,
    { flag: '--top', valueName: 'count', description: 'Maximum number of files, from 1 to 30' },
    { flag: '--max-output-bytes', valueName: 'count', description: 'Maximum UTF-8 bytes in a JSON context response (1024 to 1048576)' },
    ...refreshLimits,
    { flag: '--refresh', description: 'Rebuild parsed facts from current source files' },
  ],
  index: [...common, ...refreshLimits],
  status: [...common, ...refreshLimits],
  purge: [...common],
};
