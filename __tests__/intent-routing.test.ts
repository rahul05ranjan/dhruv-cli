import { describe, expect, it } from '@jest/globals';
import { routeIntent } from '../src/core/intent-routing';

describe('Intent Routing', () => {
  it('classifies an explanation query to the explain command with high confidence', async () => {
    const result = await routeIntent('can you explain how the logger works in this project?');

    expect(result.command).toBe('explain');
    expect(result.confidence).toBeGreaterThanOrEqual(0.60);
    expect(result.fallbackToMenu).toBe(false);
  });

  it('marks fallbackToMenu as true when confidence is below the threshold for ambiguous queries', async () => {
    const result = await routeIntent('asdf qwerty 1234 random query');

    expect(result.confidence).toBeLessThan(0.60);
    expect(result.fallbackToMenu).toBe(true);
  });

  it('detects and extracts existing workspace file path as target argument', async () => {
    const result = await routeIntent('please review src/core/logger.ts for any potential issues');

    expect(result.command).toBe('review');
    expect(result.target).toBe('src/core/logger.ts');
    expect(result.args).toEqual(['src/core/logger.ts']);
    expect(result.fallbackToMenu).toBe(false);
  });

  it('detects and extracts existing workspace directory path as target argument', async () => {
    const result = await routeIntent('audit security vulnerabilities in src/commands');

    expect(result.command).toBe('security-check');
    expect(result.target).toBe('src/commands');
    expect(result.args).toEqual(['src/commands']);
    expect(result.fallbackToMenu).toBe(false);
  });

  it('does not set target when mentioned file path does not exist in workspace', async () => {
    const result = await routeIntent('explain non_existent_virtual_file.xyz');

    expect(result.command).toBe('explain');
    expect(result.target).toBeUndefined();
    expect(result.args).toEqual(['explain non_existent_virtual_file.xyz']);
  });

  describe('all built-in commands classification coverage', () => {
    it.each([
      ['how does the auth system work?', 'explain'],
      ['recommend improvements and best practices for our schema', 'suggest'],
      ['fix the runtime crash and resolve this failing bug', 'fix'],
      ['inspect code quality and review the implementation', 'review'],
      ['optimize the performance and speed up latency', 'optimize'],
      ['check for SQL injection and secret leaks', 'security-check'],
      ['scaffold a new component and create boilerplate', 'generate'],
    ])('routes "%s" to command "%s" with confidence >= 0.60', async (query, expectedCommand) => {
      const result = await routeIntent(query);

      expect(result.command).toBe(expectedCommand);
      expect(result.confidence).toBeGreaterThanOrEqual(0.60);
      expect(result.fallbackToMenu).toBe(false);
    });
  });

  describe('external Laya server support', () => {
    it('uses classification from remote Laya server when reachable', async () => {
      const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ command: 'optimize', confidence: 0.96 }),
      } as Response);

      const result = await routeIntent('speed up this function', {
        layaServerUrl: 'http://127.0.0.1:8000',
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result.command).toBe('optimize');
      expect(result.confidence).toBe(0.96);
    });

    it('falls back to local scoring when remote Laya server fails', async () => {
      const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await routeIntent('explain this module', {
        layaServerUrl: 'http://127.0.0.1:8000',
        fetchImpl: mockFetch,
      });

      expect(result.command).toBe('explain');
      expect(result.confidence).toBeGreaterThanOrEqual(0.60);
    });
  });
});
