import fs from 'fs';
import path from 'path';
import os from 'os';

const LOCAL_CONFIG_FILE = path.join(process.cwd(), '.dhruv-config.json');
const GLOBAL_CONFIG_FILE = path.join(os.homedir(), '.config', 'dhruv', 'config.json');

export type ConfigScope = 'local' | 'global';

export interface DhruvConfig {
  model: string;
  verbose: boolean;
  responseFormat: 'text' | 'json' | 'markdown';
  timeoutMs: number;
  theme?: 'default' | 'dark' | 'light' | 'mono';
}

const defaultConfig: DhruvConfig = {
  model: 'gemma3:270m',
  verbose: false,
  responseFormat: 'text',
  timeoutMs: 45000,
  theme: 'default',
};

let sessionConfig: Partial<DhruvConfig> = {};

export function setSessionConfig(config: Partial<DhruvConfig>): void {
  sessionConfig = { ...sessionConfig, ...config };
}

export function resetSessionConfig(): void {
  sessionConfig = {};
}

export function getSessionConfig(): Partial<DhruvConfig> {
  return { ...sessionConfig };
}

function readConfigFile(file: string): DhruvConfig {
  if (fs.existsSync(file)) {
    try {
      const fileContent = fs.readFileSync(file, 'utf-8');
      const parsedConfig = JSON.parse(fileContent);
      return validateAndMergeConfig(parsedConfig);
    } catch (error) {
      console.warn(`Warning: Invalid config file. Using defaults. Error: ${(error as Error).message}`);
      return defaultConfig;
    }
  }
  return defaultConfig;
}

export function loadConfig(): DhruvConfig {
  let base: DhruvConfig;
  if (fs.existsSync(LOCAL_CONFIG_FILE)) {
    base = readConfigFile(LOCAL_CONFIG_FILE);
  } else if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    base = readConfigFile(GLOBAL_CONFIG_FILE);
  } else {
    base = defaultConfig;
  }
  return validateAndMergeConfig({ ...base, ...sessionConfig });
}

function validateAndMergeConfig(config: Partial<DhruvConfig>): DhruvConfig {
  const validatedConfig = { ...defaultConfig };
  
  // Validate model
  if (config.model && typeof config.model === 'string') {
    validatedConfig.model = config.model;
  }
  
  // Validate verbose
  if (typeof config.verbose === 'boolean') {
    validatedConfig.verbose = config.verbose;
  }
  
  // Validate responseFormat
  if (config.responseFormat && ['text', 'json', 'markdown'].includes(config.responseFormat)) {
    validatedConfig.responseFormat = config.responseFormat as 'text' | 'json' | 'markdown';
  }

  if (typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0) {
    validatedConfig.timeoutMs = Math.round(config.timeoutMs);
  }
  
  // Validate theme
  if (config.theme && ['default', 'dark', 'light', 'mono'].includes(config.theme)) {
    validatedConfig.theme = config.theme as 'default' | 'dark' | 'light' | 'mono';
  }
  
  return validatedConfig;
}

export function saveConfig(config: Partial<DhruvConfig>, options: { scope?: ConfigScope } = {}) {
  const scope = options.scope ?? 'local';
  const file = scope === 'global' ? GLOBAL_CONFIG_FILE : LOCAL_CONFIG_FILE;
  const current = fs.existsSync(file) ? readConfigFile(file) : defaultConfig;
  if (scope === 'global') fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...config }, null, 2));
}

// Use .js extension for ESM compatibility if imported elsewhere
