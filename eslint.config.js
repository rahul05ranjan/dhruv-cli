import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  // Base configuration
  js.configs.recommended,

  // Global ignores (migrated from .eslintignore)
  {
    ignores: [
      'dist/',
      'node_modules/',
      'node-fetch.d.ts',
      'coverage/',
      '.dhruv-cache/',
      'logs/',
      'docs/'
    ]
  },

  // TypeScript files configuration (excluding test files)
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['__tests__/**/*', '**/*.test.ts', '**/*.spec.ts', 'src/core/logger.ts', 'src/core/security.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
        ecmaVersion: 2020,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { 
        'argsIgnorePattern': '^_|error|e',
        'varsIgnorePattern': '^_|response|error|e|Command|printSuccess|printInfo|printWarning|detectProjectType',
        'ignoreRestSiblings': true
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': ['warn', {
        'ignoreRestArgs': true
      }],
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-undef': 'off', // Turn off because we're using globals
      'no-redeclare': 'off', // Allow redeclaration of globals
      'no-unused-vars': 'off', // Turn off base rule, use @typescript-eslint/no-unused-vars
    },
  },

  // Lenient configuration for files with external library interfaces
  {
    files: ['src/core/logger.ts', 'src/core/security.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
        ecmaVersion: 2020,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off', // Allow any in these files due to Winston/security libraries
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
    },
  },

  // JavaScript files configuration
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2020,
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-undef': 'off', // Turn off because we're using globals
      'no-redeclare': 'off', // Allow redeclaration of globals
      'no-unused-vars': 'off', // Allow unused vars in JS files for flexibility
    },
  },

  // Test files configuration (separate project config)
  {
    files: ['__tests__/**/*.{ts,js}', '**/*.test.{ts,js}', '**/*.spec.{ts,js}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2020,
        // Don't use project for test files since they're not in tsconfig.json
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { 
        'argsIgnorePattern': '^_|error|e',
        'varsIgnorePattern': '^_|response|error|e|Command|printSuccess|printInfo|printWarning|detectProjectType',
        'ignoreRestSiblings': true
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off', // Turn off because we're using globals
      'no-redeclare': 'off', // Allow redeclaration of globals
      'no-unused-vars': 'off', // Turn off base rule, use @typescript-eslint/no-unused-vars
    },
  },
];
