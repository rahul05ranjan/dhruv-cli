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
import { commandDescription, completionCommands, completionOptions } from './core/command-catalog.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();

program
  .name('dhruv')
  .description('AI-powered CLI assistant for developers using Ollama')
  .version(pkg.version);

program
  .command('explain <query>')
  .description(commandDescription('explain'))
  .addHelpText('after', '\nExamples:\n  $ dhruv explain "What is async/await?"\n  $ dhruv explain "Docker containers vs VMs"')
  .action(explain);

program
  .command('suggest <query>')
  .description(commandDescription('suggest'))
  .addHelpText('after', '\nExamples:\n  $ dhruv suggest "React performance optimization"\n  $ dhruv suggest "Node.js project structure"')
  .action(suggest);

program
  .command('fix <query>')
  .description(commandDescription('fix'))
  .addHelpText('after', '\nExamples:\n  $ dhruv fix "TypeError: Cannot read property of undefined"\n  $ dhruv fix "CORS error in Express.js"')
  .action(fix);

program
  .command('review <fileOrDir>')
  .description(commandDescription('review'))
  .option('--diff', 'Review the current uncommitted git diff')
  .action((fileOrDir: string, command: Command) => review(fileOrDir, command.opts()));

program
  .command('optimize <file>')
  .description(commandDescription('optimize'))
  .action(optimize);

program
  .command('security-check [fileOrDir]')
  .description(commandDescription('security-check'))
  .option('--strict', 'Exit with failure when high-confidence findings are detected')
  .action((fileOrDir: string | undefined, command: Command) => securityCheck(fileOrDir, command.opts()));

program
  .command('generate <type> <target>')
  .description(commandDescription('generate'))
  .option('--apply', 'Write generated tests to disk (preview is the default)')
  .option('--output <path>', 'Write generated tests to this path')
  .option('--overwrite', 'Allow replacing an existing output file')
  .action((type: string, target: string, command: Command) => generate(type, target, command.opts()));

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
  .action((command: Command) => health(command.opts()));

program
  .command('metrics')
  .description(commandDescription('metrics'))
  .option('--raw', 'Export raw Prometheus metrics')
  .option('--reset', 'Clear persisted local metrics')
  .action((command: Command) => metrics(command.opts()));

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
  .option('--model <model>', 'Set Ollama model')
  .option('--verbose', 'Enable verbose output')
  .option('--json', 'Output in JSON format')
  .option('--timeout <milliseconds>', 'Set the AI request timeout')
  .hook('preAction', async (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.model || opts.verbose || opts.json || opts.timeout) {
      const config: Record<string, unknown> = {};
      if (opts.model) config.model = opts.model;
      if (opts.verbose) config.verbose = true;
      if (opts.json) config.responseFormat = 'json';
      if (opts.timeout) config.timeoutMs = Number(opts.timeout);
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
  .description(commandDescription('completion'))
  .argument('[shell]', 'shell type (bash|zsh|fish)', 'bash')
  .action((shell: string) => {
    const commands = completionCommands();
    const options = completionOptions();
    let script = '';
    switch (shell) {
      case 'zsh':
        script = `#compdef dhruv\n_dhruv_completion() {\n  _arguments '1:command:(${commands})' '*:option:(${options})'\n}\ncompdef _dhruv_completion dhruv`;
        break;
      case 'fish':
        script = `complete -c dhruv -f -n '__fish_use_subcommand' -a '${commands}'\ncomplete -c dhruv -f -n 'not __fish_use_subcommand' -a '${options}'`;
        break;
      case 'bash':
        script = String.raw`#!/bin/bash
_dhruv_completion() {
  local commands="${commands}"
  local options="${options}"
  local choices="$commands $options"
  COMPREPLY=( $(compgen -W "$choices" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _dhruv_completion dhruv`;
        break;
      default:
        console.error(chalk.red(`Unsupported shell "${shell}". Choose bash, zsh, or fish.`));
        process.exitCode = 2;
        return;
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
