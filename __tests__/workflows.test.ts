import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
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
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: Step[]; if?: string }>;
}

const root = resolve(__dirname, '..');
const workflow = (name: string): Workflow =>
  parse(readFileSync(resolve(root, '.github/workflows', name), 'utf8'));

const atLeast = (version: string, minimum: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(version) && version.localeCompare(minimum, 'en', { numeric: true }) >= 0;

describe('release workflow requirements', () => {
  it('does not retain redundant publishing or deployment workflows', () => {
    for (const name of ['auto-assign.yml', 'build-publish.yml', 'deploy.yml', 'monitoring.yml']) {
      expect(existsSync(resolve(root, '.github/workflows', name))).toBe(false);
    }
  });

  it('installs an OIDC-capable npm CLI where semantic-release looks for executables', () => {
    // The plugin uses preferLocal: true. A global npm upgrade cannot fix an
    // older CLI hoisted here by a conflicting @semantic-release/npm version.
    const npm = JSON.parse(readFileSync(resolve(root, 'node_modules/npm/package.json'), 'utf8'));
    expect(atLeast(npm.version, '11.5.1')).toBe(true);
  });

  it.each(['release.yml'])(
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
    const publishers = ['ci.yml', 'release.yml']
      .filter(name => {
        const config = workflow(name);
        return config.on.push && Object.values(config.jobs).some(job =>
          job.steps.some(step => /npx semantic-release|npm publish(?! --dry-run)/.test(step.run ?? '')));
      });
    expect(publishers).toEqual(['release.yml']);
  });
});

describe('workflow trigger boundaries', () => {
  it('runs branch and pull-request validation only for the default branch', () => {
    for (const name of ['ci.yml', 'contribution.yml', 'labeler.yml', 'dependabot-auto-merge.yml']) {
      const config = workflow(name);
      const trigger = name === 'ci.yml'
        ? 'push'
        : name === 'dependabot-auto-merge.yml' ? 'pull_request_target' : 'pull_request';
      const event = config.on[trigger] as { branches?: string[] };
      expect(event.branches).toEqual(['main']);
    }
  });

  it('keeps expensive security jobs off pull-request runs', () => {
    const config = workflow('security.yml');
    for (const name of ['license-check', 'supply-chain', 'sbom-generation']) {
      expect(config.jobs[name]?.if).toBe("github.event_name != 'pull_request'");
    }
  });
});

describe('Dependabot automation', () => {
  it('uses the PR author and accepts unsigned Dependabot commits', () => {
    const config = workflow('dependabot-auto-merge.yml');
    const expectedGuard =
      "github.event.pull_request.user.login == 'dependabot[bot]' && github.event.pull_request.draft == false";

    expect(config.jobs['auto-approve']?.if).toBe(expectedGuard);
    expect(config.jobs['auto-merge']?.if).toBe(expectedGuard);

    const metadata = config.jobs['auto-merge']?.steps.find(step =>
      step.uses?.startsWith('dependabot/fetch-metadata@'));
    expect(metadata?.with?.['skip-commit-verification']).toBe(true);

    const autoMergeSteps = config.jobs['auto-merge']?.steps.filter(step =>
      step.uses?.startsWith('peter-evans/enable-pull-request-automerge@')) ?? [];
    expect(autoMergeSteps).toHaveLength(2);
    for (const step of autoMergeSteps) {
      expect(step.with?.['pull-request-number']).toBe('${{ github.event.pull_request.number }}');
    }
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
    const steps = Object.values(workflow('security.yml').jobs).flatMap(job => job.steps);
    const uploads = steps.filter(step => step.uses?.includes('/upload-sarif@'));
    expect(uploads.map(step => step.with?.sarif_file)).toEqual([
      'results.sarif', '${{ steps.scan.outputs.sarif }}',
    ]);
  });

  it('meets Scorecard publishing restrictions on permissions and job isolation', () => {
    const config = workflow('security.yml');
    expect(Object.values(config.permissions ?? {})).not.toContain('write');
    // Scorecard's results API accepts only these actions in the producing job.
    const allowed = ['actions/checkout', 'actions/upload-artifact',
      'github/codeql-action/upload-sarif', 'ossf/scorecard-action', 'step-security/harden-runner'];
    for (const step of config.jobs['security-scorecard'].steps) {
      expect(allowed).toContain(step.uses?.split('@')[0]);
    }
  });
});

describe('package distribution and licensing compliance', () => {
  it('defines an explicit MIT license in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('MIT');
  });

  it('provides a canonical root LICENSE file with copyright notice', () => {
    const licensePath = resolve(root, 'LICENSE');
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, 'utf8');
    expect(content).toContain('MIT License');
    expect(content).toContain('Copyright (c) 2026 Rahul Ranjan');
  });
});
