# Dhruv CLI

AI-powered CLI assistant for developers using Ollama.

## 🚀 Features
- Smart command suggestions: `suggest`, `explain`, `fix`
- Project context detection (Node, React, Python, etc.)
- Code review: `review <fileOrDir>`
- Code optimization: `optimize <file>`
- Security analysis: `security-check [fileOrDir]`
- Test/code generation: `generate <type> <target>`
- Interactive setup: `init`
- Streaming AI responses in terminal
- Syntax highlighting for code output
- Progress bars for long operations
- Plugin system: drop ESM modules in `plugins/`
- Autocomplete: `completion [shell]`
- Offline-first with local Ollama models
- Beautiful, modern CLI UX

## 🛠️ Installation
```bash
npm install -g dhruv-cli
```

## 📝 Usage Examples
```bash
dhruv suggest "deploy react app to vercel"
dhruv explain "git rebase vs merge"
dhruv fix "cors error in express"
dhruv review src/
dhruv optimize package.json
dhruv security-check src/
dhruv generate tests src/utils/helpers.js
dhruv init
dhruv completion bash > dhruv-complete.sh # Enable tab completion
```

## 🧩 Plugins
Add new commands by dropping ESM modules in the `plugins/` directory. Example:
```js
// plugins/hello.js
export default (program) => {
  program.command('hello-plugin').action(() => console.log('Hello from plugin!'));
};
```

## 📦 Configuration
- Run `dhruv init` to set model, response format, and verbosity.
- Project type auto-detected for context-aware suggestions.

## 🖥️ Advanced UX
- Streaming output, syntax highlighting, progress bars, colored errors, and interactive menus.

## License
MIT
