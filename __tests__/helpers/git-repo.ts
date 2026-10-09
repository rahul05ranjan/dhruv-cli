import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temporary Git repository isolated from the developer's Git configuration. */
export class TempRepo {
  readonly root: string;
  readonly globalConfig: string;
  readonly hooksPath: string;

  constructor(prefix = 'dhruv-git-') {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    this.globalConfig = path.join(this.root, '.git', 'test-global.gitconfig');
    this.hooksPath = path.join(this.root, '.git', 'empty-hooks');
    this.git('init', '-q', '-b', 'main');
    fs.writeFileSync(this.globalConfig, '');
    fs.mkdirSync(this.hooksPath);
  }

  git(...args: string[]): string {
    return execFileSync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${this.hooksPath}`,
      ...args,
    ], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: this.globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  }

  write(file: string, content: string | Buffer): void {
    const target = path.join(this.root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  /** Writes files, stages everything and commits. Returns the commit ID. */
  commit(files: Record<string, string | Buffer>, message = 'change'): string {
    for (const [file, content] of Object.entries(files)) this.write(file, content);
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  remove(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
