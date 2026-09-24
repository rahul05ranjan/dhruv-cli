import chalk from 'chalk';
import { detectProjectType } from '../utils/projectType.js';

/** The `project-type` command: prints the project type detected in the current directory. */
export function projectType(): void {
  const type = detectProjectType();
  console.log(chalk.blue(`Detected project type: ${type}`));
}
