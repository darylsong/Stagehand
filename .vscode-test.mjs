import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throwaway repo opened as the workspace for integration tests.
const repo = mkdtempSync(join(tmpdir(), 'stagehand-it-'));
const git = (...args) => execFileSync('git', args, { cwd: repo });
git('init', '-q', '-b', 'integration-branch');
git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: repo,
  launchArgs: ['--disable-extensions'],
});
