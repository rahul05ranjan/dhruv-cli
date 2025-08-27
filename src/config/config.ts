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
    try {
      const fileContent = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsedConfig = JSON.parse(fileContent);
      return validateAndMergeConfig(parsedConfig);
    } catch (error) {
      console.warn(`Warning: Invalid config file. Using defaults. Error: ${(error as Error).message}`);
      return defaultConfig;
    }
  }
  return defaultConfig;
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
  
  // Validate theme
  if (config.theme && ['default', 'dark', 'light', 'mono'].includes(config.theme)) {
    validatedConfig.theme = config.theme as 'default' | 'dark' | 'light' | 'mono';
  }
  
  return validatedConfig;
}

export function saveConfig(config: Partial<DhruvConfig>) {
  const current = loadConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...config }, null, 2));
}

// Use .js extension for ESM compatibility if imported elsewhere
