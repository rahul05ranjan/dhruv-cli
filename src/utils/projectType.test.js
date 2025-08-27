import fs from 'fs';
import { detectProjectType } from 'jest';

// Use .js extension for ESM compatibility
import fs from 'fs';
import { detectProjectType } from 'jest';

function detectProjectType(): string {
  if (fs.existsSync('package.json')) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'react';
    if (pkg.dependencies?.express || pkg.devDependencies?.express) return 'node-express';
    return 'node';
  } else {
    return 'unknown';
  }
}