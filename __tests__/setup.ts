import { jest } from '@jest/globals';

// Setup test environment
beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = 'test';

  // Mock console methods to reduce noise during tests
  global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
});

afterAll(async () => {
  // Cleanup
  delete process.env.NODE_ENV;
});

// Mock process.exit to prevent tests from exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit() was called');
});

afterEach(() => {
  mockExit.mockClear();
});

// Global test utilities
(global as Record<string, unknown>).testUtils = {
  // Helper to wait for async operations
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  // Helper to create temporary files for testing
  createTempFile: (content: string, filename: string = 'test.txt') => {
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(process.cwd(), '.test-temp');

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  },

  // Helper to clean up temporary files
  cleanupTempFiles: () => {
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(process.cwd(), '.test-temp');

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
};
