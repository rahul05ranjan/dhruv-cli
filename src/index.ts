#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { review } from './commands/review.js';
import { optimize } from './commands/optimize.js';
import { securityCheck } from './commands/security-check.js';
import { generate } from './commands/generate.js';
import { init } from './commands/init.js';
import { status } from './commands/status.js';
import { health } from './commands/health.js';
import { metrics } from './commands/metrics.js';
import { detectProjectType } from './utils/projectType.js';
import { menu } from './commands/menu.js';
import { registerBuiltInCommands } from './commands/register-built-in-commands.js';
import { createRequire } from 'module';
import { logger, logCommand, logInfo, logError } from './core/logger.js';
import { metricsCollector } from './core/metrics.js';
import { securityManager } from './core/security.js';
import { commandDescription } from './core/command-catalog.js';
import { completion } from './commands/completion.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();

program
  .name('dhruv')
  .description('AI-powered CLI assistant for developers using Ollama')
  .version(pkg.version);

registerBuiltInCommands(program);

// Legacy source-driven commands: #127 moves these into Built-in Command definitions.
// Legacy diagnostics and setup commands: #128 moves these into Built-in Command definitions.
program
  .command('init')
  .description(commandDescription('init'))
  .action(init);

program
  .command('status')
  .description(commandDescription('status'))
  .action(status);

program
  .command('health')
  .description(commandDescription('health'))
  .option('--details', 'Show every health check and diagnostic detail')
  .action((options: Record<string, any>) => health(options));

program
  .command('metrics')
  .description(commandDescription('metrics'))
  .option('--raw', 'Export raw Prometheus metrics')
  .option('--reset', 'Clear persisted local metrics')
  .action((options: Record<string, any>) => metrics(options));

program
  .command('project-type')
  .description(commandDescription('project-type'))
  .action(() => {
    const type = detectProjectType();
    console.log(chalk.blue(`Detected project type: ${type}`));
  });

program
  .command('menu')
  .description(commandDescription('menu'))
  .action(menu);

program
  .hook('preAction', async (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.model || opts.verbose || opts.json || opts.timeout) {
      const config: Record<string, unknown> = {};
      if (opts.model) config.model = opts.model;
      if (opts.verbose) config.verbose = true;
      if (opts.json) config.responseFormat = 'json';
      if (opts.timeout) config.timeoutMs = Number(opts.timeout);
      // Set in-memory config overrides for the session
      const configModule = await import('./config/config.js');
      configModule.setSessionConfig(config);
    }
  });

async function loadPlugins(program: unknown) {
  const PLUGIN_DIR = path.join(process.cwd(), 'plugins');
  if (fs.existsSync(PLUGIN_DIR)) {
    const files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const pluginPath = path.join(PLUGIN_DIR, file).replace(/\\/g, '/');
        const pluginUrl = new URL('file://' + (pluginPath.startsWith('/') ? '' : '/') + pluginPath);
        const plugin = await import(pluginUrl.href);
        if (typeof plugin.default === 'function') plugin.default(program);
        else if (typeof plugin === 'function') plugin(program);
      } catch (e) {
        console.error(chalk.red(`Failed to load plugin ${file}: ${(e as Error).message}`));
      }
    }
  }
}

(async () => {
  // Initialize enterprise features
  try {
    logInfo('Dhruv CLI starting', {
      version: pkg.version,
      nodeVersion: process.version,
      platform: process.platform
    });

    // Record session start
    metricsCollector.recordSession();

    await loadPlugins(program);
    program.parse(process.argv);

    // Record successful session
    const sessionId = logger.getSessionId();
    logInfo('CLI session completed', { sessionId });

  } catch (error) {
    logError('CLI startup failed', error as Error);
    console.error(chalk.red('Failed to start Dhruv CLI:'), (error as Error).message);
    process.exit(1);
  }
})();

// Autocomplete: Generate shell completion scripts
program
  .command('completion')
  .description(commandDescription('completion'))
  .argument('[shell]', 'shell type (bash|zsh|fish)', 'bash')
  .action(completion);

process.on('uncaughtException', async (err) => {
  const ux = await import('./utils/ux.js');
  ux.printError('Uncaught error: ' + err.message);
  process.exit(1);
});
process.on('unhandledRejection', async (reason: unknown) => {
  const ux = await import('./utils/ux.js');
  ux.printError('Unhandled rejection: ' + ((reason as Error)?.message || reason));
  process.exit(1);
});
