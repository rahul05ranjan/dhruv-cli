/**
 * Completion adapter: builds bash, zsh and fish completion scripts from
 * Built-in Command definitions. Each command advertises only its own options,
 * plus the global options and help. Before a command (and for Plugin Commands,
 * which have no definition) only the program-level options are offered.
 */
import chalk from 'chalk';
import { builtInCommands, findBuiltInCommand, globalOptions, type BuiltInArgument, type BuiltInOption } from './built-in-commands.js';

const helpOption: BuiltInOption = { flags: '-h, --help', description: 'display help for command' };

interface CompletionFlag {
  short?: string;
  long?: string;
  valueName?: string;
  description: string;
}

interface CompletionTarget {
  name: string;
  choices?: { position: number; name: string; values: readonly string[] };
  completeFiles: boolean;
  /** 1-based position of the first argument that takes file paths. */
  filesFrom?: number;
  flags: CompletionFlag[];
}

function parseFlags(option: BuiltInOption): CompletionFlag {
  const tokens = option.flags.split(/[ ,|]+/).filter(Boolean);
  const value = tokens.find((token) => /^[<[]/.test(token));
  return {
    short: tokens.find((token) => /^-[^-]$/.test(token)),
    long: tokens.find((token) => token.startsWith('--')),
    valueName: value?.replace(/[<>[\]]/g, ''),
    description: option.description,
  };
}

function argumentFacts(args: readonly BuiltInArgument[] = []): Pick<CompletionTarget, 'choices' | 'completeFiles' | 'filesFrom'> {
  const position = args.findIndex((argument) => argument.choices);
  const withChoices = args[position];
  const filesIndex = args.findIndex((argument) => argument.completeFiles);
  return {
    choices: withChoices?.choices ? { position: position + 1, name: withChoices.name, values: withChoices.choices } : undefined,
    completeFiles: filesIndex !== -1,
    filesFrom: filesIndex === -1 ? undefined : filesIndex + 1,
  };
}

function completionTargets(): CompletionTarget[] {
  return builtInCommands.map((definition) => ({
    name: definition.name,
    ...argumentFacts(definition.arguments),
    flags: [...(definition.options ?? []), ...globalOptions, helpOption].map(parseFlags),
  }));
}

/** Program-level options: accepted before any command. */
function programOptions(): string[] {
  return ['--help', '--version', ...globalOptions.map((option) => parseFlags(option).long ?? '')].filter(Boolean);
}

function flagWords(flags: CompletionFlag[]): string {
  return flags.flatMap((flag) => [flag.long, flag.short]).filter(Boolean).join(' ');
}

function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bashScript(targets: CompletionTarget[], commands: string, options: string): string {
  const choiceBlocks = targets.filter((target) => target.choices?.position === 1).map((target) => `
  if [[ "$cur" != -* && "$prev" == "${target.name}" ]]; then
    COMPREPLY=( $(compgen -W "${target.choices?.values.join(' ')}" -- "$cur") )
    return 0
  fi`).join('');
  const fileCommands = targets.filter((target) => target.filesFrom !== undefined);
  const fileBlock = fileCommands.length === 0 ? '' : `
  if [[ "$cur" != -* ]] && [[ ${fileCommands.map((target) => `( "\${COMP_WORDS[1]}" == "${target.name}" && $COMP_CWORD -gt ${target.filesFrom} )`).join(' || ')} ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi`;
  const perCommandBlock = `
  if [[ $COMP_CWORD -gt 1 ]]; then
    case "\${COMP_WORDS[1]}" in
${targets.map((target) => `      ${target.name})
        commands=""
        options="${flagWords(target.flags)}"
        ;;`).join('\n')}
      *)
        commands=""
        ;;
    esac
  fi`;

  return `#!/bin/bash
_dhruv_completion() {
  local cur prev commands options
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${commands}"
  options="${options}"
${choiceBlocks}${fileBlock}${perCommandBlock}

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$options" -- "$cur") )
  elif [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$commands $options" -- "$cur") )
  fi
}
complete -F _dhruv_completion dhruv`;
}

function zshOptionSpecs(flag: CompletionFlag): string[] {
  const description = flag.description.replace(/([[\]:\\])/g, '\\$1');
  const value = flag.valueName ? `:${flag.valueName}:` : '';
  return [flag.long, flag.short].filter(Boolean).map((name) => singleQuoted(`${name}[${description}]${value}`));
}

function zshBranch(target: CompletionTarget): string | undefined {
  const specs = [
    ...(target.choices ? [`'${target.choices.position}:${target.choices.name}:(${target.choices.values.join(' ')})'`] : []),
    ...(target.completeFiles ? [`'*:file:_files'`] : []),
    ...target.flags.flatMap(zshOptionSpecs),
  ];
  return specs.length === 0 ? undefined : `        ${target.name}) _arguments ${specs.join(' ')} ;;`;
}

function zshScript(targets: CompletionTarget[], commands: string, options: string): string {
  const branches = targets.map(zshBranch).filter(Boolean).join('\n');
  return `#compdef dhruv
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
${branches}
        *)
          _arguments '*:options:(${options})'
          ;;
      esac
      ;;
  esac
}
compdef _dhruv_completion dhruv`;
}

function fishScript(targets: CompletionTarget[], commands: string, options: string): string {
  const seen = (name: string) => `'__fish_seen_subcommand_from ${name}'`;
  const lines = [`complete -c dhruv -f -n '__fish_use_subcommand' -a '${commands}'`];
  for (const target of targets.filter((candidate) => candidate.choices)) {
    const atPosition = `'__fish_seen_subcommand_from ${target.name}; and test (count (commandline -opc)) -eq ${(target.choices?.position ?? 0) + 1}'`;
    lines.push(`complete -c dhruv -f -n ${atPosition} -a '${target.choices?.values.join(' ')}'`);
  }
  for (const target of targets) {
    lines.push(`complete -c dhruv ${target.completeFiles ? '-F' : '-f'} -n ${seen(target.name)}`);
    for (const flag of target.flags) {
      const names = [flag.short && `-s ${flag.short.slice(1)}`, flag.long && `-l ${flag.long.slice(2)}`].filter(Boolean).join(' ');
      lines.push(`complete -c dhruv -n ${seen(target.name)} ${names}${flag.valueName ? ' -r' : ''} -d ${singleQuoted(flag.description)}`);
    }
  }
  const otherCommands = `not __fish_use_subcommand; and not __fish_seen_subcommand_from ${targets.map((target) => target.name).join(' ')}`;
  lines.push(`complete -c dhruv -f -n '${otherCommands}' -a '${options}'`);
  return lines.join('\n');
}

/** Returns the completion script for a supported shell, or undefined. */
export function completionScript(shell: string): string | undefined {
  const targets = completionTargets();
  const commands = targets.map((target) => target.name).join(' ');
  const options = programOptions().join(' ');
  switch (shell) {
  case 'bash':
    return bashScript(targets, commands, options);
  case 'zsh':
    return zshScript(targets, commands, options);
  case 'fish':
    return fishScript(targets, commands, options);
  default:
    return undefined;
  }
}

/** The shells the `completion` definition offers, as "a, b, or c". Read lazily: the definition imports this module. */
function shellChoices(): string {
  const shells = [...(findBuiltInCommand('completion')?.arguments?.[0]?.choices ?? [])];
  return shells.length < 2 ? shells.join('') : `${shells.slice(0, -1).join(', ')}, or ${shells[shells.length - 1]}`;
}

/** The `completion` command: prints the script, or exits 2 for an unsupported shell. */
export function completion(shell: string = 'bash'): void {
  const script = completionScript(shell);
  if (script === undefined) {
    console.error(chalk.red(`Unsupported shell "${shell}". Choose ${shellChoices()}.`));
    process.exitCode = 2;
    return;
  }
  console.log(script);
  console.log(`\n# To enable tab completion, add the above to your shell profile or source it directly.`);
}
