import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('stagehand.showCurrentBranch', () => {
  test('returns the branch of the workspace repo', async () => {
    // Workspace is a temp repo created in .vscode-test.mjs on branch "integration-branch".
    const branch = await vscode.commands.executeCommand<string>('stagehand.showCurrentBranch');
    assert.strictEqual(branch, 'integration-branch');
  });
});
