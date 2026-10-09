#!/usr/bin/env node
export {};

/** The command word, skipping leading global options (and the values of those that take one). */
function commandWord(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--model' || args[index] === '--timeout') index++;
    else if (!args[index].startsWith('-')) return args[index];
  }
  return undefined;
}

// Keep the explicit, local Nano path outside the AI-backed startup sequence.
// In particular, importing cli-main loads logging and workspace plugins.
// `check` is read-only review of possibly untrusted changes, so it stays out as well.
const command = commandWord(process.argv.slice(2));
if (process.argv[2] === 'nano') {
  const { runNanoCli } = await import('./nano/cli.js');
  await runNanoCli(process.argv);
} else if (command === 'check') {
  const { runCheckCli } = await import('./check/cli.js');
  await runCheckCli(process.argv);
} else {
  await import('./cli-main.js');
}
