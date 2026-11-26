import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', '.vscode-test/', 'test-results/', 'playwright-report/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: 'src/core must stay VS Code-free. Put VS Code code in src/extension.' }],
      }],
    },
  },
);
