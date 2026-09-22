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
  .action((fileOrDir: string, options: Record<string, any>) => review(fileOrDir, options));

program
  .command('optimize <file>')
  .description(commandDescription('optimize'))
  .action(optimize);

program
  .command('security-check [fileOrDir]')
  .description(commandDescription('security-check'))
  .option('--strict', 'Exit with failure when high-confidence findings are detected')
  .action((fileOrDir: string | undefined, options: Record<string, any>) => securityCheck(fileOrDir, options));

program
  .command('generate <type> <target>')
  .description(commandDescription('generate'))
  .option('--apply', 'Write generated tests to disk (preview is the default)')
  .option('--output <path>', 'Write generated tests to this path')
  .option('--overwrite', 'Allow replacing an existing output file')
  .action((type: string, target: string, options: Record<string, any>) => generate(type, target, options));

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
  .action((shell: string) => {
    const commands = completionCommands();
    const options = completionOptions();
    let script: string;
    switch (shell) {
      case 'zsh':
        script = `#compdef dhruv
_dhruv_completion() {
  local -a commands
  commands=(${commands})
  _arguments -C \\
    '1:command:->cmds' \\
    '*::options:->args'
  case "$state" in
    cmds)
      _describe -t commands 'dhruv command' commands
      ;;
    args)
      case $words[1] in
        generate)
          _arguments '1:type:(tests documentation docs component)' '*:file:_files'
          ;;
        review|optimize|security-check)
          _arguments '*:file:_files'
          ;;
        completion)
          _arguments '1:shell:(bash zsh fish)'
          ;;
        *)
          _arguments '*:options:(${options})'
          ;;
      esac
      ;;
  esac
}
compdef _dhruv_completion dhruv`;
        break;
      case 'fish':
        script = `complete -c dhruv -f -n '__fish_use_subcommand' -a '${commands}'\ncomplete -c dhruv -f -n '__fish_seen_subcommand_from generate' -a 'tests documentation docs component'\ncomplete -c dhruv -f -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'\ncomplete -c dhruv -f -n 'not __fish_use_subcommand' -a '${options}'`;
        break;
      case 'bash':
        script = String.raw`#!/bin/bash
_dhruv_completion() {
  local cur prev commands options
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${commands}"
  options="${options}"

  if [[ "$prev" == "generate" ]]; then
    COMPREPLY=( $(compgen -W "tests documentation docs component" -- "$cur") )
    return 0
  fi
  if [[ "$prev" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
    return 0
  fi
  if [[ "$prev" == "review" || "$prev" == "optimize" || "$prev" == "security-check" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$options" -- "$cur") )
  elif [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$commands $options" -- "$cur") )
  fi
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
