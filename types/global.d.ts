declare global {
  namespace NodeJS {
    interface Global {
      testUtils: {
        wait: (ms: number) => Promise<void>;
        createTempFile: (content: string, filename?: string) => string;
        cleanupTempFiles: () => void;
      };
    }
  }
}

export {};
