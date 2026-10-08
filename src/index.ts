#!/usr/bin/env node
export {};

// Keep the explicit, local Nano path outside the AI-backed startup sequence.
// In particular, importing cli-main loads logging and workspace plugins.
if (process.argv[2] === 'nano') {
  const { runNanoCli } = await import('./nano/cli.js');
  await runNanoCli(process.argv);
} else {
  await import('./cli-main.js');
}
