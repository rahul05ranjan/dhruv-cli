import { CHECK_SEVERITIES } from './check-findings.js';
import type { RangeFile } from './committed-range.js';
import { walkUnifiedPatch } from './unified-patch.js';

function formatRanges(file: RangeFile): string {
  return file.changedLines
    .flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
    .join(', ');
}

function numberPatch(patch: string): string {
  const out: string[] = [];
  walkUnifiedPatch(patch, (text, line, kind) => {
    out.push(kind === '@' ? text : kind === '-' ? `-       : ${text}` : `${kind}${String(line).padStart(5)}: ${text}`);
  });
  return out.join('\n');
}

/** The exact per-file text delivered to the model, including path and line labels. */
export function filePromptSection(file: RangeFile): string {
  const renamed = file.oldPath ? ` (renamed from ${file.oldPath})` : '';
  return `FILE ${file.path}${renamed} - changed lines: ${formatRanges(file)}\n${numberPatch(file.patch)}`;
}

const shape = `{"findings":[{"path":"<file path as shown>","line":<number of a + line>,"severity":"<${CHECK_SEVERITIES.join('|')}>","reason":"<one-sentence summary of the problem>","evidence":"<what in the change shows it>","recommendation":"<how to fix it>"}]}`;
const prefix = `Please review this committed change. Only the lines marked with + are new and carry their line number; the rest is context. Report concrete problems in the changed lines only.\n\nRespond with one JSON object in exactly this shape and nothing else:\n${shape}\nRespond with {"findings":[]} if you find nothing worth reporting.\n\nCODE_START\n`;
const suffix = '\nCODE_END';

export const PROMPT_OVERHEAD_BYTES = Buffer.byteLength(prefix + suffix);
export const PROMPT_SEPARATOR_BYTES = Buffer.byteLength('\n\n');

export function buildCheckPrompt(files: RangeFile[]): string {
  return `${prefix}${files.map(filePromptSection).join('\n\n')}${suffix}`;
}
