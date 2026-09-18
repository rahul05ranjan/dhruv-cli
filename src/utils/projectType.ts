// Use .js extension for ESM compatibility
import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger.js';

export interface ProjectContext {
  type: string;
  framework?: string;
  diagnostic?: string;
}

export function detectProjectDetails(directory: string = process.cwd()): ProjectContext {
  const file = (name: string) => path.join(directory, name);

  if (fs.existsSync(file('package.json'))) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf-8'));
    } catch (err) {
      const diagnostic = `Malformed package.json in ${directory}: ${(err as Error).message}`;
      logger.warn(diagnostic);
      return { type: 'unknown', diagnostic };
    }

    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    if (dependencies.react) return { type: 'node', framework: 'react' };
    if (dependencies.next) return { type: 'node', framework: 'nextjs' };
    if (dependencies.vue) return { type: 'node', framework: 'vue' };
    if (dependencies['@angular/core']) return { type: 'node', framework: 'angular' };
    if (dependencies.svelte) return { type: 'node', framework: 'svelte' };
    if (dependencies['@nestjs/core']) return { type: 'node', framework: 'nestjs' };
    if (dependencies.express) return { type: 'node', framework: 'node-express' };
    if (dependencies.typescript || fs.existsSync(file('tsconfig.json'))) return { type: 'node-typescript' };
    return { type: 'node' };
  }

  if (fs.existsSync(file('tsconfig.json'))) {
    return { type: 'node-typescript' };
  }

  if (fs.existsSync(file('requirements.txt')) || fs.existsSync(file('pyproject.toml')) || fs.existsSync(file('Pipfile')) || fs.existsSync(file('setup.py'))) {
    let framework: string | undefined;
    if (fs.existsSync(file('manage.py'))) {
      framework = 'django';
    } else if (fs.existsSync(file('requirements.txt'))) {
      try {
        const reqs = fs.readFileSync(file('requirements.txt'), 'utf-8');
        if (/fastapi/i.test(reqs)) framework = 'fastapi';
        else if (/flask/i.test(reqs)) framework = 'flask';
        else if (/django/i.test(reqs)) framework = 'django';
      } catch (err) {
        const diagnostic = `Error reading requirements.txt: ${(err as Error).message}`;
        logger.warn(diagnostic);
        return { type: 'python', diagnostic };
      }
    }
    return { type: 'python', framework };
  }

  if (fs.existsSync(file('go.mod'))) return { type: 'go' };
  if (fs.existsSync(file('Cargo.toml'))) return { type: 'rust' };
  if (fs.existsSync(file('pom.xml')) || fs.existsSync(file('build.gradle')) || fs.existsSync(file('build.gradle.kts'))) {
    let framework: string | undefined;
    try {
      const pomPath = file('pom.xml');
      const gradlePath = file('build.gradle');
      const content = fs.existsSync(pomPath)
        ? fs.readFileSync(pomPath, 'utf-8')
        : (fs.existsSync(gradlePath) ? fs.readFileSync(gradlePath, 'utf-8') : '');
      if (/spring-boot/i.test(content)) framework = 'spring-boot';
    } catch {
      // safe fallback
    }
    return { type: 'java', framework };
  }

  return { type: 'unknown' };
}

export function detectProjectType(directory: string = process.cwd()): string {
  const details = detectProjectDetails(directory);
  if (details.type === 'unknown') return 'unknown';
  if (details.framework) {
    if (details.framework === 'react' || details.framework === 'nextjs' || details.framework === 'node-express') {
      return details.framework;
    }
    return `${details.type}-${details.framework}`;
  }
  return details.type;
}
