import chalk from 'chalk';
// @ts-ignore
import cliProgress from 'cli-progress';
import { highlight } from 'cli-highlight';
import { loadConfig } from '../config/config.js';

function getTheme() {
  const config = loadConfig();
  switch (config.theme) {
    case 'dark':
      return { primary: chalk.cyanBright, accent: chalk.magentaBright, error: chalk.redBright, success: chalk.greenBright };
    case 'light':
      return { primary: chalk.blue, accent: chalk.yellow, error: chalk.red, success: chalk.green };
    case 'mono':
      return { primary: chalk.white, accent: chalk.gray, error: chalk.white.bgRed, success: chalk.white.bgGreen };
    default:
      return { primary: chalk.cyan, accent: chalk.green, error: chalk.bgRed.white, success: chalk.bgGreen.white };
  }
}

export function highlightCode(code: string, lang = 'js') {
  return highlight(code, { language: lang, ignoreIllegals: true });
}

export function printError(message: string) {
  const { error } = getTheme();
  console.error(error(' ERROR '), error(message));
}

export function printSuccess(message: string) {
  const { success } = getTheme();
  console.log(success(' SUCCESS '), success(message));
}

export function createProgressBar(total: number) {
  const { primary } = getTheme();
  const bar = new cliProgress.SingleBar({
    format: primary('Progress') + ' |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });
  bar.start(total, 0);
  return bar;
}

export function themed(text: string, type: 'primary' | 'accent' = 'primary') {
  const theme = getTheme();
  return theme[type](text);
}
