import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Commit } from '../core/git';

suite('stagehand.showCurrentBranch', () => {
  test('returns the branch of the workspace repo', async () => {
    // Workspace is a temp repo created in .vscode-test.mjs on branch "integration-branch".
    const branch = await vscode.commands.executeCommand<string>('stagehand.showCurrentBranch');
    assert.strictEqual(branch, 'integration-branch');
  });
});

suite('stagehand.history', () => {
  test('the view can be focused', async () => {
    await vscode.commands.executeCommand('stagehand.history.focus');
  });

  test('loadCommits returns the init commit', async () => {
    const commits = await vscode.commands.executeCommand<Commit[]>('stagehand.history.loadCommits', { skip: 0, limit: 1000 });
    assert.deepStrictEqual(commits.map((c) => c.subject), ['init']);
  });
});
