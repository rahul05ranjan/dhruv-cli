#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { explain } from './commands/explain.js';
import { suggest } from './commands/suggest.js';
import { fix } from './commands/fix.js';
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
import { createRequire } from 'module';
import { logger, logCommand, logInfo, logError } from './core/logger.js';
import { metricsCollector } from './core/metrics.js';
import { securityManager } from './core/security.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();

program
  .name('dhruv')
  .description('AI-powered CLI assistant for developers using Ollama')
  .version(pkg.version);

program
  .command('explain <query>')
  .description('Explain a concept or command')
  .addHelpText('after', '\nExamples:\n  $ dhruv explain "What is async/await?"\n  $ dhruv explain "Docker containers vs VMs"')
  .action(explain);

program
  .command('suggest <query>')
  .description('Get AI-powered suggestions')
  .addHelpText('after', '\nExamples:\n  $ dhruv suggest "React performance optimization"\n  $ dhruv suggest "Node.js project structure"')
  .action(suggest);

program
  .command('fix <query>')
  .description('Get a fix for a coding issue or error')
  .addHelpText('after', '\nExamples:\n  $ dhruv fix "TypeError: Cannot read property of undefined"\n  $ dhruv fix "CORS error in Express.js"')
  .action(fix);

program
  .command('review <fileOrDir>')
  .description('Review code in a file or directory')
  .action(review);

program
  .command('optimize <file>')
  .description('Optimize a file (e.g., package.json)')
  .action(optimize);

program
  .command('security-check [fileOrDir]')
  .description('Run a security check on code')
  .action(securityCheck);

program
  .command('generate <type> <target>')
  .description('Generate code/tests for a file')
  .action(generate);

program
  .command('init')
  .description('Interactive setup/configuration wizard')
  .action(init);

program
  .command('status')
  .description('Check Ollama connection and available models')
  .action(status);

program
  .command('health')
  .description('Run comprehensive health check')
  .action(health);

program
  .command('metrics')
  .description('Display CLI usage metrics')
  .action(metrics);

program
  .command('project-type')
  .description('Detect and print the current project type')
  .action(() => {
    const type = detectProjectType();
    console.log(chalk.blue(`Detected project type: ${type}`));
  });

program
  .command('menu')
  .description('Interactive command palette')
  .action(menu);

program
  .option('--model <model>', 'Set Ollama model')
  .option('--verbose', 'Enable verbose output')
  .option('--json', 'Output in JSON format')
  .hook('preAction', async (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.model || opts.verbose || opts.json) {
      const config: Record<string, unknown> = {};
      if (opts.model) config.model = opts.model;
      if (opts.verbose) config.verbose = true;
      if (opts.json) config.responseFormat = 'json';
      // Save config for session
      const configModule = await import('./config/config.js');
      configModule.saveConfig(config);
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
  .description('Generate shell completion script')
  .argument('[shell]', 'shell type (bash|zsh|fish)', 'bash')
  .action((shell: string) => {
    let script = '';
    switch (shell) {
      case 'zsh':
        script = `#compdef dhruv\n_dhruv_completion() {\n  reply=( $(dhruv --help | awk '/Commands:/,/^$/ {if(NR>1)print $1}') )\n}\ncompctl -K _dhruv_completion dhruv`;
        break;
      case 'fish':
        script = `function __fish_dhruv_complete\n  dhruv --help | awk '/Commands:/,/^$/ {if(NR>1)print $1}'\nend\ncomplete -c dhruv -a '(__fish_dhruv_complete)'`;
        break;
      default:
        script = String.raw`#!/bin/bash
_dhruv_completion() {
  COMPREPLY=( $(compgen -W "$(dhruv --help | awk '/Commands:/,/^$/ {if(NR>1)print $1}')" -- \${COMP_WORDS[1]}) )
}
complete -F _dhruv_completion dhruv`;
    }
    console.log(script);
    console.log(`\n# To enable tab completion, add the above to your shell profile or source it directly.`);
  });

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
