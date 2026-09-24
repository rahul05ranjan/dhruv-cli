import type { BuiltInCommand } from '../built-in-commands.js';
import type { HealthOptions } from '../health.js';
import type { MetricsOptions } from '../metrics.js';
import { init } from '../init.js';
import { status } from '../status.js';
import { health } from '../health.js';
import { metrics } from '../metrics.js';
import { projectType } from '../project-type.js';
import { menu } from '../menu.js';
import { completion } from '../completion.js';

/**
 * Diagnostics, setup and remaining commands (init … completion).
 *
 * Actions stay wrapped in closures: `menu` and `completion` import the
 * definitions, so their bindings are only safe to read at call time.
 */
export const diagnosticCommands: readonly BuiltInCommand[] = [
  {
    name: 'init',
    description: 'Interactive setup/configuration wizard',
    menuLabel: 'Init (Setup)',
    run: () => init(),
  },
  {
    name: 'status',
    description: 'Check Ollama connection and available models',
    menuLabel: 'Status',
    run: () => status(),
  },
  {
    name: 'health',
    description: 'Run comprehensive health check',
    menuLabel: 'Health Check',
    options: [{ flags: '--details', description: 'Show every health check and diagnostic detail' }],
    run: (_args, options) => health(options as HealthOptions),
  },
  {
    name: 'metrics',
    description: 'Display CLI usage metrics',
    menuLabel: 'Metrics',
    options: [
      { flags: '--raw', description: 'Export raw Prometheus metrics' },
      { flags: '--reset', description: 'Clear persisted local metrics' },
    ],
    run: (_args, options) => metrics(options as MetricsOptions),
  },
  {
    name: 'project-type',
    description: 'Detect and print the current project type',
    menuLabel: 'Project Type',
    run: () => projectType(),
  },
  {
    name: 'menu',
    description: 'Interactive command palette',
    menuLabel: 'Menu',
    // Selecting the menu from inside the menu is a no-op, as before.
    menuHint: 'You selected: menu',
    run: () => menu(),
  },
  {
    name: 'completion',
    description: 'Generate shell completion script',
    menuLabel: 'Shell Completion',
    arguments: [{
      name: 'shell',
      required: false,
      description: 'shell type (bash|zsh|fish)',
      defaultValue: 'bash',
      // Literal on purpose: reading `supportedShells` here would cycle through completion.ts.
      choices: ['bash', 'zsh', 'fish'],
    }],
    menuHint: 'Run `dhruv completion <bash|zsh|fish>` to install shell completion.',
    run: ({ shell }) => completion(shell),
  },
];
