import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import {
  presentSourceOutcome,
  TextPresentationAdapter,
  JsonPresentationAdapter,
} from '../src/core/command-presentation';
import type { SourceFailureOutcome, SourceSuccessOutcome } from '../src/core/source-ingestion';

jest.mock('../src/utils/ux', () => ({
  printError: jest.fn(),
  printInfo: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
}));

describe('Command Presentation Adapters', () => {
  const failure: SourceFailureOutcome = {
    ok: false,
    reason: 'not-found',
    target: 'missing.ts',
    message: 'Path "missing.ts" does not exist or could not be read.',
  };

  const successCapped: SourceSuccessOutcome = {
    ok: true,
    target: 'src',
    files: [],
    isDiff: false,
    capped: true,
    promptContent: '',
    maxFiles: 10,
  };

  beforeEach(() => {
    process.exitCode = 0;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('renders clear text failure and sets exitCode to 1 in text adapter', async () => {
    const { printError } = await import('../src/utils/ux');
    const adapter = new TextPresentationAdapter();

    const result = presentSourceOutcome('review', failure, adapter);

    expect(result).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(printError).toHaveBeenCalledWith('Path "missing.ts" does not exist or could not be read.');
  });

  it('renders structured JSON failure and sets exitCode to 1 in json adapter without calling printError', async () => {
    const { printError } = await import('../src/utils/ux');
    const adapter = new JsonPresentationAdapter();
    const stdoutChunks: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const result = presentSourceOutcome('review', failure, adapter);

      expect(result).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(printError).not.toHaveBeenCalled();

      const raw = stdoutChunks.join('');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed).toEqual({
        ok: false,
        command: 'review',
        error: 'Path "missing.ts" does not exist or could not be read.',
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('prints directory cap notice in text adapter', async () => {
    const { printInfo } = await import('../src/utils/ux');
    const adapter = new TextPresentationAdapter();

    const result = presentSourceOutcome('review', successCapped, adapter);

    expect(result).toBe(true);
    expect(printInfo).toHaveBeenCalledWith('Note: Directory review is capped at the first 10 source files.');
  });

  it('suppresses directory cap notice in json adapter', async () => {
    const { printInfo } = await import('../src/utils/ux');
    const adapter = new JsonPresentationAdapter();
    const stdoutChunks: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const result = presentSourceOutcome('review', successCapped, adapter);

      expect(result).toBe(true);
      expect(printInfo).not.toHaveBeenCalled();
      expect(stdoutChunks).toHaveLength(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
