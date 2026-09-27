import { exec } from 'node:child_process';
import {
  executeSelfHealingLoop,
  type CommandExecutor,
  type PatchGenerator,
  type FilePatch,
  type FileSystemAdapter,
  defaultFsAdapter,
} from '../core/self-healing.js';
import { ask } from '../core/ai.js';
import { logError } from '../core/logger.js';

export interface RunCommandOptions {
  autoFix?: boolean;
  apply?: boolean;
  maxIterations?: string | number;
  json?: boolean;
}

export interface RunDependencies {
  executor?: CommandExecutor;
  patcher?: PatchGenerator;
  fsAdapter?: FileSystemAdapter;
  prompter?: (diff: string, filePath: string) => Promise<boolean>;
  isTTY?: boolean;
}

/**
 * Executes a shell command via child process, capturing exit code, stdout, and stderr.
 */
export const defaultChildProcessExecutor: CommandExecutor = (command: string, cwd: string) => {
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({
        exitCode,
        stdout: stdout || '',
        stderr: stderr || (error ? error.message : ''),
      });
    });
  });
};

/**
 * Synthesizes patches for failing files using Ollama.
 */
export const defaultAiPatcher: PatchGenerator = async (input) => {
  const fileEntries = Object.entries(input.files);
  if (fileEntries.length === 0) {
    return {
      patches: [],
      explanation: 'No candidate source files found in workspace matching the error trace.',
    };
  }

  const prompt = `Command failed with exit code ${input.exitCode}:
Command: ${input.command}
Error output:
${input.stderr.slice(0, 3000)}

Files involved:
${fileEntries.map(([path, content]) => `--- ${path} ---\n${content.slice(0, 3000)}`).join('\n\n')}

Analyze the error and provide the updated content for the file to fix the issue. Return your response in JSON format:
{
  "filePath": "<file path>",
  "explanation": "<short explanation of the fix>",
  "patchedContent": "<full replacement content of the file>"
}`;

  try {
    const rawResponse = await ask({
      prompt,
      systemMessage: 'You are an autonomous coding repair agent. Fix the error by providing corrected source code.',
    });

    const parsed = JSON.parse(rawResponse.trim()) as {
      filePath?: string;
      explanation?: string;
      patchedContent?: string;
    };

    if (parsed.filePath && parsed.patchedContent && input.files[parsed.filePath]) {
      const patch: FilePatch = {
        filePath: parsed.filePath,
        originalContent: input.files[parsed.filePath],
        patchedContent: parsed.patchedContent,
      };
      return {
        patches: [patch],
        explanation: parsed.explanation || 'Applied AI-generated fix',
      };
    }
  } catch (err) {
    logError('AI patch generation failed', err as Error);
  }

  return {
    patches: [],
    explanation: 'Could not generate valid patch',
  };
};

/**
 * Prompts user interactively in TTY mode to preview diff and confirm applying patch.
 */
export async function defaultPromptConfirmation(diff: string, filePath: string): Promise<boolean> {
  const { default: chalk } = await import('chalk');
  console.log(chalk.bold(`\nProposed patch for ${filePath}:`));
  const coloredDiff = diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      if (line.startsWith('@') || line.startsWith('---') || line.startsWith('+++')) return chalk.cyan(line);
      return line;
    })
    .join('\n');
  console.log(coloredDiff);

  try {
    const { default: inquirer } = await import('inquirer');
    const response = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'apply',
        message: `Apply this patch to ${filePath}?`,
        default: true,
      },
    ]);
    return Boolean(response.apply);
  } catch {
    return false;
  }
}

/**
 * Command action for `dhruv run <command>`.
 */
export async function run(
  commandToRun: string,
  options: RunCommandOptions = {},
  dependencies: RunDependencies = {}
): Promise<void> {
  const cwd = process.cwd();
  const executor = dependencies.executor || defaultChildProcessExecutor;
  const fsAdapter = dependencies.fsAdapter || defaultFsAdapter;
  const patcher = dependencies.patcher || defaultAiPatcher;
  const isTTY = dependencies.isTTY ?? Boolean(process.stdin?.isTTY);
  const prompter = dependencies.prompter || defaultPromptConfirmation;

  if (!options.autoFix) {
    const result = await executor(commandToRun, cwd);
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: result.exitCode === 0,
          command: 'run',
          targetCommand: commandToRun,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        })
      );
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
    return;
  }

  const maxIterations = options.maxIterations ? Number(options.maxIterations) : 3;

  const onBeforeApplyPatch = async (patch: FilePatch, _iteration: number): Promise<boolean> => {
    // If --apply is set or not in TTY mode, apply without prompting
    if (options.apply || !isTTY) {
      return true;
    }
    return prompter(patch.diff || '', patch.filePath);
  };

  const loopResult = await executeSelfHealingLoop(commandToRun, {
    cwd,
    maxIterations,
    executor,
    patcher,
    fsAdapter,
    onBeforeApplyPatch,
  });

  if (options.json) {
    console.log(
      JSON.stringify({
        ok: loopResult.success,
        command: 'run',
        targetCommand: commandToRun,
        iterations: loopResult.iterations,
        modifiedFiles: loopResult.modifiedFiles,
        diffs: loopResult.diffs || [],
        exitCode: loopResult.finalExitCode,
        explanation: loopResult.explanation,
        rolledBack: loopResult.rolledBack,
        error: loopResult.error,
      })
    );
  } else {
    const { default: chalk } = await import('chalk');
    if (loopResult.success) {
      console.log(chalk.green(`\n✔ Command passed after ${loopResult.iterations} iteration(s)!`));
      if (loopResult.modifiedFiles.length > 0) {
        console.log(chalk.cyan(`Fixed files: ${loopResult.modifiedFiles.join(', ')}`));
      }
    } else {
      console.log(chalk.red(`\n✖ Command failed after ${loopResult.iterations} iteration(s).`));
      if (loopResult.rolledBack) {
        console.log(chalk.yellow(`Changes were rolled back to their original state.`));
      }
    }
  }

  process.exitCode = loopResult.finalExitCode;
}
