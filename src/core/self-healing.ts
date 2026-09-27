import fs from 'fs/promises';
import path from 'path';

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (
  command: string,
  cwd: string
) => Promise<CommandExecutionResult>;

export interface FilePatch {
  filePath: string;
  originalContent: string;
  patchedContent: string;
  diff?: string;
}

export interface PatchGeneratorInput {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Record<string, string>;
}

export type PatchGenerator = (
  input: PatchGeneratorInput
) => Promise<{ patches: FilePatch[]; explanation?: string }>;

export interface FileSystemAdapter {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  fileExists: (filePath: string) => Promise<boolean>;
}

export interface SelfHealingOptions {
  cwd?: string;
  maxIterations?: number;
  executor?: CommandExecutor;
  patcher?: PatchGenerator;
  fsAdapter?: FileSystemAdapter;
  onIteration?: (iteration: number, status: 'running' | 'failed' | 'passed' | 'patching') => void;
}

export interface SelfHealingResult {
  success: boolean;
  iterations: number;
  modifiedFiles: string[];
  finalExitCode: number;
  explanation?: string;
  rolledBack: boolean;
  error?: string;
}

export const DEFAULT_MAX_ITERATIONS = 3;

export const defaultFsAdapter: FileSystemAdapter = {
  readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
  writeFile: (filePath: string, content: string) => fs.writeFile(filePath, content, 'utf-8'),
  fileExists: async (filePath: string) => {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Extracts candidate file paths from stack traces, test runner failures, and compiler diagnostics.
 */
export async function extractErrorCandidateFiles(
  stderr: string,
  stdout: string,
  cwd: string,
  fsAdapter: FileSystemAdapter = defaultFsAdapter
): Promise<string[]> {
  const text = `${stderr}\n${stdout}`;
  const candidates = new Set<string>();

  // Patterns for extracting file paths
  const patterns: RegExp[] = [
    // Jest FAIL __tests__/file.test.ts
    /FAIL\s+([^\s:]+\.[a-zA-Z0-9]+)/g,
    // Stack trace (path/to/file.ext:line:col)
    /\(([^:)\s]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?\)/g,
    // at path/to/file.ext:line:col
    /at\s+(?:[^\s(]+\s+\()?([^:)\s]+\.[a-zA-Z0-9]+):(\d+)/g,
    // TypeScript / ESLint: path/to/file.ext:line:col
    /(?:^|\s)([\w./\\-]+\.[a-zA-Z0-9]+):\d+:\d+/g,
    // Python traceback: File "path/to/file.py", line 12
    /File\s+["']([^"']+\.[a-zA-Z0-9]+)["']/g,
    // Cargo/Rust: --> path/to/file.rs:12:4
    /-->\s+([^:)\s]+\.[a-zA-Z0-9]+):\d+:\d+/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawPath = match[1];
      if (!rawPath) continue;

      // Filter out node internals or node_modules
      if (rawPath.startsWith('node:') || rawPath.includes('node_modules')) {
        continue;
      }

      const normalized = path.isAbsolute(rawPath)
        ? path.relative(cwd, rawPath)
        : rawPath.replace(/^[./\\]+/, '');

      if (await fsAdapter.fileExists(normalized)) {
        candidates.add(normalized);
      } else if (await fsAdapter.fileExists(rawPath)) {
        candidates.add(rawPath);
      }
    }
  }

  return Array.from(candidates);
}

/**
 * Pure Autonomous Self-Healing Loop Coordinator.
 */
export async function executeSelfHealingLoop(
  command: string,
  options?: SelfHealingOptions
): Promise<SelfHealingResult> {
  const cwd = options?.cwd ?? process.cwd();
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const executor = options?.executor;
  const patcher = options?.patcher;
  const fsAdapter = options?.fsAdapter ?? defaultFsAdapter;

  if (!executor) {
    throw new Error('CommandExecutor adapter is required');
  }

  // Pre-mutation snapshots map: filePath -> original content
  const snapshots: Map<string, string> = new Map();
  const modifiedFilesSet: Set<string> = new Set();
  let latestExplanation: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    options?.onIteration?.(iteration, 'running');

    const execution = await executor(command, cwd);

    if (execution.exitCode === 0) {
      options?.onIteration?.(iteration, 'passed');
      return {
        success: true,
        iterations: iteration,
        modifiedFiles: Array.from(modifiedFilesSet),
        finalExitCode: 0,
        explanation: latestExplanation,
        rolledBack: false,
      };
    }

    options?.onIteration?.(iteration, 'failed');

    // If we've reached the maximum iterations without passing
    if (iteration === maxIterations) {
      // Automatic Rollback
      for (const [filePath, originalContent] of snapshots.entries()) {
        await fsAdapter.writeFile(filePath, originalContent);
      }

      return {
        success: false,
        iterations: iteration,
        modifiedFiles: [],
        finalExitCode: execution.exitCode,
        explanation: latestExplanation,
        rolledBack: snapshots.size > 0,
        error: `Self-healing loop exceeded maximum iterations (${maxIterations}) without passing`,
      };
    }

    if (!patcher) {
      return {
        success: false,
        iterations: iteration,
        modifiedFiles: Array.from(modifiedFilesSet),
        finalExitCode: execution.exitCode,
        rolledBack: false,
        error: 'No patch generator available to synthesize fixes',
      };
    }

    options?.onIteration?.(iteration, 'patching');

    // Ingest candidate file contents
    const candidateFiles = await extractErrorCandidateFiles(
      execution.stderr,
      execution.stdout,
      cwd,
      fsAdapter
    );

    const filesContent: Record<string, string> = {};
    for (const file of candidateFiles) {
      try {
        filesContent[file] = await fsAdapter.readFile(file);
      } catch {
        // Skip unreadable files
      }
    }

    // Generate and apply patch
    const patchResult = await patcher({
      command,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      files: filesContent,
    });

    latestExplanation = patchResult.explanation;

    for (const patch of patchResult.patches) {
      // Snapshot original content before first mutation
      if (!snapshots.has(patch.filePath)) {
        snapshots.set(patch.filePath, patch.originalContent);
      }

      await fsAdapter.writeFile(patch.filePath, patch.patchedContent);
      modifiedFilesSet.add(patch.filePath);
    }
  }

  return {
    success: false,
    iterations: maxIterations,
    modifiedFiles: Array.from(modifiedFilesSet),
    finalExitCode: 1,
    rolledBack: false,
  };
}
