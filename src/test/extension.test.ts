import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Commit } from '../core/git';
import { handleMessage, webviewHtml } from '../extension/extension';

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

suite('webview message handling', () => {
  test('loadCommits replies with the workspace repo commits', async () => {
    const replies: unknown[] = [];
    await handleMessage({ type: 'loadCommits', skip: 0, limit: 1000 }, (r) => replies.push(r));
    assert.strictEqual(replies.length, 1);
    const reply = replies[0] as { type: string; skip: number; commits: Commit[] };
    assert.strictEqual(reply.type, 'commits');
    assert.strictEqual(reply.skip, 0);
    assert.deepStrictEqual(reply.commits.map((c) => c.subject), ['init']);
  });

  test('a failure replies with an error message', async () => {
    const replies: unknown[] = [];
    await handleMessage({ type: 'loadCommits', skip: 0, limit: 1000 }, (r) => replies.push(r), async () => {
      throw new Error('boom');
    });
    assert.deepStrictEqual(replies, [{ type: 'error', message: 'boom' }]);
  });
});

suite('webview HTML', () => {
  // Compiled tests live in out/test; the built webview is in out/webview.
  const built = resolve(__dirname, '..', 'webview');

  test('has a CSP allowing only extension scripts and inline styles', () => {
    const html = webviewHtml(built, 'https://x.test/main.js', 'https://x.test');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    assert.strictEqual(csp, "default-src 'none'; script-src https://x.test; style-src 'unsafe-inline';");
    assert.match(html, /<script src="https:\/\/x\.test\/main\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline scripts');
  });

  test('shows a message when index.html is missing', () => {
    const html = webviewHtml(mkdtempSync(join(tmpdir(), 'stagehand-empty-')), 'main.js', 'x');
    assert.match(html, /webview not built/);
  });
});
