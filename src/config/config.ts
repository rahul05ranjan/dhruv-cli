import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), '.dhruv-config.json');

export interface DhruvConfig {
  model: string;
  verbose: boolean;
  responseFormat: 'text' | 'json' | 'markdown';
  theme?: 'default' | 'dark' | 'light' | 'mono';
}

const defaultConfig: DhruvConfig = {
  model: 'codellama',
  verbose: false,
  responseFormat: 'text',
  theme: 'default',
};

export function loadConfig(): DhruvConfig {
  if (fs.existsSync(CONFIG_FILE)) {
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  }
  return defaultConfig;
}

export function saveConfig(config: Partial<DhruvConfig>) {
  const current = loadConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...config }, null, 2));
}

// Use .js extension for ESM compatibility if imported elsewhere
