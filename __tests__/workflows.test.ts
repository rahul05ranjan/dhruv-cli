import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string | number>;
}

interface Workflow {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const root = resolve(__dirname, '..');
const workflow = (name: string): Workflow =>
  parse(readFileSync(resolve(root, '.github/workflows', name), 'utf8'));

const atLeast = (version: string, minimum: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(version) && version.localeCompare(minimum, 'en', { numeric: true }) >= 0;

describe('release workflow requirements', () => {
  it('installs an OIDC-capable npm CLI where semantic-release looks for executables', () => {
    // The plugin uses preferLocal: true. A global npm upgrade cannot fix an
    // older CLI hoisted here by a conflicting @semantic-release/npm version.
    const npm = JSON.parse(readFileSync(resolve(root, 'node_modules/npm/package.json'), 'utf8'));
    expect(atLeast(npm.version, '11.5.1')).toBe(true);
  });

  it.each(['build-publish.yml', 'release.yml', 'deploy.yml'])(
    '%s provisions a supported Node and npm before publishing',
    name => {
      const config = workflow(name);
      for (const job of Object.values(config.jobs)) {
        const publishIndex = job.steps.findIndex(step =>
          /npm publish|npx semantic-release/.test(step.run ?? ''));
        if (publishIndex < 0) continue;
        const setup = job.steps.slice(0, publishIndex).find(step =>
          step.uses?.startsWith('actions/setup-node@'));
        const nodeVersion = String(setup?.with?.['node-version']).replace(
          /\$\{\{ env\.(\w+) \}\}/g, (_, key: string) => config.env?.[key] ?? '');
        expect(atLeast(nodeVersion, '22.14.0')).toBe(true);
        const npmSetup = job.steps.slice(0, publishIndex).find(step =>
          /npm install --global npm@/.test(step.run ?? ''));
        const npmVersion = npmSetup?.run?.match(/npm@(\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0';
        expect(atLeast(npmVersion, '11.5.1')).toBe(true);
      }
    });

  it('has one automatic publisher for main pushes', () => {
    const publishers = ['ci.yml', 'build-publish.yml', 'release.yml']
      .filter(name => {
        const config = workflow(name);
        return config.on.push && Object.values(config.jobs).some(job =>
          job.steps.some(step => /npx semantic-release|npm publish(?! --dry-run)/.test(step.run ?? '')));
      });
    expect(publishers).toEqual(['release.yml']);
  });
});

describe('security workflow requirements', () => {
  it('lets TruffleHog select the commit range for push, PR, schedule and manual events', () => {
    const steps = workflow('security.yml').jobs['secret-scan'].steps;
    const scanner = steps.find(step => step.uses?.startsWith('trufflesecurity/trufflehog@'));
    expect(scanner).toBeDefined();
    // Hard-coding main/HEAD makes push-to-main scans fail before scanning.
    expect(scanner?.with?.base).toBeUndefined();
    expect(scanner?.with?.head).toBeUndefined();
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('uploads the Anchore report instead of uploading the Scorecard report twice', () => {
    const steps = workflow('security.yml').jobs['security-scorecard'].steps;
    const uploads = steps.filter(step => step.uses?.includes('/upload-sarif@'));
    expect(uploads.map(step => step.with?.sarif_file)).toEqual([
      'results.sarif', '${{ steps.scan.outputs.sarif }}',
    ]);
  });
});
