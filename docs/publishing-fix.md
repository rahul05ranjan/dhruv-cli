# npm publishing issue resolution

## Issue

GitHub Actions was failing with:

```text
npm ERR! 403 403 Forbidden - PUT https://registry.npmjs.org/@rahul05ranjan%2fdhruv-cli - You cannot publish over the previously published versions: 0.0.0-development.
```

## Resolution

- Updated the package version from `0.0.0-development` to `1.4.0`.
- Added semantic-release configuration and plugins.
- Removed direct npm publishing from the CI workflow.
- Added a dedicated publishing workflow with version-conflict checks.
- Enabled trusted publishing with npm provenance.

## Release conventions

Use conventional commit messages so semantic-release can determine the next version:

```bash
# Patch
git commit -m "fix: resolve a connection issue"

# Minor
git commit -m "feat: add a new command"

# Major
git commit -m "feat!: change the command output contract"
```

The authoritative release configuration lives in [`.releaserc.json`](../.releaserc.json) and the workflows live in [`.github/workflows/`](../.github/workflows/).
