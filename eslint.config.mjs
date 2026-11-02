import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'test/fixtures/**', '*.mjs', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'child_process', message: 'Spawn processes only through ProcessRunner.' },
            { name: 'node:child_process', message: 'Spawn processes only through ProcessRunner.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/process-runner.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
