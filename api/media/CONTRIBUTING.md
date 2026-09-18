# Contributing to Dhruv CLI

Thank you for your interest in contributing! 🎉

## How to Contribute

- **Bug Reports & Feature Requests:**
  - Use [GitHub Issues](../../issues) to report bugs or request features.
- **Pull Requests:**
  - Fork the repo and create a new branch for your change.
  - Write clear, concise commit messages.
  - Ensure your code passes lint and build checks.
  - Add or update tests as needed.
  - Document your changes in the PR description.

## Development Setup

1. Clone the repo and install dependencies:
   ```sh
   git clone <repo-url>
   cd devai-cli
   npm install
   ```
2. Build and run locally:
   ```sh
   npm run build
   npm start
   ```
3. For development:
   ```sh
   npm run dev
   ```

## Code Style
- Use TypeScript and follow the existing code style.
- Run `npx eslint .` before submitting a PR.

## Testing
- Add tests for new features or bug fixes.
- Run tests with `npm test`.

## Commit Message Guidelines
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
- **Allowed PR title types:**
  - feat
  - fix
  - chore
  - docs
  - refactor
  - style
  - test
  - ci
- Example: `fix: update version to 1.1.3 and improve streaming response handling`
- PR titles are checked automatically in CI. See `.github/workflows/contribution.yml` for details.

## Code of Conduct
- Be respectful and inclusive. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License
By contributing, you agree that your contributions will be licensed under the MIT License.
