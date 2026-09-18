// Use .js extension for ESM compatibility
import fs from 'fs';
import path from 'path';

export function detectProjectType(directory: string = process.cwd()): string {
  const file = (name: string) => path.join(directory, name);

  if (fs.existsSync(file('package.json'))) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf-8'));
    } catch {
      return 'unknown';
    }

    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    if (dependencies.react) return 'react';
    if (dependencies.next) return 'nextjs';
    if (dependencies.express) return 'node-express';
    if (dependencies.typescript || fs.existsSync(file('tsconfig.json'))) return 'node-typescript';
    return 'node';
  }
  if (fs.existsSync(file('requirements.txt'))) return 'python';
  if (fs.existsSync(file('pyproject.toml'))) return 'python';
  if (fs.existsSync(file('go.mod'))) return 'go';
  if (fs.existsSync(file('Cargo.toml'))) return 'rust';
  if (fs.existsSync(file('pom.xml')) || fs.existsSync(file('build.gradle'))) return 'java';
  return 'unknown';
}
