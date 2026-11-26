import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChangedFile, Commit, CommitDetails } from '../core/git';
import { gitError, STASH_KEPT } from '../core/git';
import { checkout, handleMessage, repoDir, webviewHtml } from '../extension/extension';

// Workspace repo (.vscode-test.mjs): "init" adds file.txt ("old"), "modify" changes it to "new".
const commitNamed = async (subject: string) =>
  (await vscode.commands.executeCommand<Commit[]>('stagehand.history.loadCommits', { skip: 0, limit: 1000 })).find((c) => c.subject === subject)!;

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

  test('loadCommits returns the workspace commits newest first', async () => {
    const commits = await vscode.commands.executeCommand<Commit[]>('stagehand.history.loadCommits', { skip: 0, limit: 1000 });
    assert.deepStrictEqual(commits.map((c) => c.subject), ['modify', 'init']);
  });

  test('commitDetails returns the init commit with its full message', async () => {
    const init = await commitNamed('init');
    const details = await vscode.commands.executeCommand<CommitDetails>('stagehand.history.commitDetails', init!.hash);
    assert.strictEqual(details.subject, 'init');
    assert.strictEqual(details.message, 'init');
    assert.strictEqual(details.hash, init!.hash);
    assert.strictEqual(details.authorEmail, 't@t');
  });

  test('changedFiles returns the file the init commit added', async () => {
    const init = await commitNamed('init');
    const files = await vscode.commands.executeCommand<ChangedFile[]>('stagehand.history.changedFiles', init!.hash);
    assert.deepStrictEqual(files, [{ status: 'A', path: 'file.txt', binary: false }]);
  });

  test('changedFiles with two hashes returns the combined list', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    const result = await vscode.commands.executeCommand('stagehand.history.changedFiles', [modify.hash, init.hash]);
    // init added file.txt and modify changed it: added overall, from nothing (init is a root) to modify.
    assert.deepStrictEqual(result, { files: [{ status: 'A', path: 'file.txt', binary: false, target: modify.hash }], gap: 0 });
  });

  const activeDiff = () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'active tab is a diff');
    return { tab, input: tab.input };
  };
  const text = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();

  test('openDiff shows parent and commit content of a modified file in a preview diff tab', async () => {
    const modify = await commitNamed('modify');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('stagehand.history.openDiff', modify.hash, { status: 'M', path: 'file.txt', binary: false });
    const { tab, input } = activeDiff();
    assert.strictEqual(input.original.scheme, 'stagehand');
    assert.strictEqual(await text(input.original), 'old\n');
    assert.strictEqual(await text(input.modified), 'new\n');
    assert.strictEqual(tab.label, `file.txt (${modify.hash.slice(0, 8)})`);
    assert.strictEqual(tab.isPreview, true);
  });

  test('openDiff with preview false pins the tab; an added file has an empty left side', async () => {
    const init = await commitNamed('init');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('stagehand.history.openDiff', init.hash, { status: 'A', path: 'file.txt', binary: false }, false);
    const { tab, input } = activeDiff();
    assert.strictEqual(await text(input.original), '');
    assert.strictEqual(await text(input.modified), 'old\n');
    assert.strictEqual(tab.isPreview, false);
  });

  test('openDiff puts a rename\'s old path on the left and the new path on the right; a missing side is empty', async () => {
    // Synthetic rename on "modify": file.txt (exists in the parent) -> gone.txt (exists nowhere, so the right is empty).
    const modify = await commitNamed('modify');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('stagehand.history.openDiff', modify.hash, { status: 'R', oldPath: 'file.txt', path: 'gone.txt', binary: false });
    const { input } = activeDiff();
    assert.strictEqual(input.original.path, '/file.txt');
    assert.strictEqual(input.modified.path, '/gone.txt');
    assert.strictEqual(await text(input.original), 'old\n');
    assert.strictEqual(await text(input.modified), '');
  });

  test('openDiff of a combined-list file opens the base..target range diff', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = { status: 'M', path: 'file.txt', binary: false, base: init.hash, target: modify.hash };
    // The hash argument is ignored for a range: pass init so a single-commit diff would show '' on the left.
    await vscode.commands.executeCommand('stagehand.history.openDiff', init.hash, file);
    const { tab, input } = activeDiff();
    assert.strictEqual(await text(input.original), 'old\n');
    assert.strictEqual(await text(input.modified), 'new\n');
    assert.strictEqual(tab.label, `file.txt (${init.hash.slice(0, 8)}..${modify.hash.slice(0, 8)})`);
  });

  test('openDiff opens nothing for a binary file', async () => {
    const modify = await commitNamed('modify');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('stagehand.history.openDiff', modify.hash, { status: 'M', path: 'file.txt', binary: true });
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, undefined);
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
    assert.deepStrictEqual(reply.commits.map((c) => c.subject), ['modify', 'init']);
    // Labels and the HEAD marker reach the webview as refs.
    assert.deepStrictEqual(reply.commits.map((c) => c.refs), [['HEAD -> integration-branch'], []]);
  });

  test('loadCommits with skip/limit replies with that page of the real log', async () => {
    const replies: unknown[] = [];
    await handleMessage({ type: 'loadCommits', skip: 1, limit: 1 }, (r) => replies.push(r));
    const reply = replies[0] as { type: string; skip: number; commits: Commit[] };
    assert.strictEqual(reply.skip, 1);
    assert.deepStrictEqual(reply.commits.map((c) => c.subject), ['init']);
  });

  test('a failure replies with an error message', async () => {
    const replies: unknown[] = [];
    await handleMessage({ type: 'loadCommits', skip: 0, limit: 1000 }, (r) => replies.push(r), async () => {
      throw new Error('boom');
    });
    assert.deepStrictEqual(replies, [{ type: 'error', kind: 'git', message: 'boom' }]);
  });

  test('in the integration repo, loadCommits through the real command reports no error', async () => {
    const replies: { type: string }[] = [];
    await handleMessage({ type: 'loadCommits', skip: 0, limit: 1000 }, (r) => replies.push(r as { type: string }));
    assert.deepStrictEqual(replies.map((r) => r.type), ['commits']);
  });

  test('an error kind thrown by a command survives executeCommand and reaches the webview', async () => {
    const cmd = vscode.commands.registerCommand('stagehand.test.throwNotRepo', () => {
      throw gitError('not-repo');
    });
    try {
      const replies: unknown[] = [];
      await handleMessage({ type: 'loadCommits' }, (r) => replies.push(r), (_c, ...args) =>
        vscode.commands.executeCommand('stagehand.test.throwNotRepo', ...args));
      assert.deepStrictEqual(replies, [{ type: 'error', kind: 'not-repo', message: 'Not a git repository' }]);
    } finally {
      cmd.dispose();
    }
  });

  test('with no workspace folder the repo lookup fails with the no-folder kind', () => {
    assert.throws(() => repoDir([]), { kind: 'no-folder', message: 'No folder open' });
  });

  test('commitDetails replies with the details from the command', async () => {
    const init = await commitNamed('init');
    const replies: unknown[] = [];
    await handleMessage({ type: 'commitDetails', hash: init!.hash }, (r) => replies.push(r));
    assert.strictEqual(replies.length, 1);
    const reply = replies[0] as { type: string; details: CommitDetails };
    assert.strictEqual(reply.type, 'details');
    assert.strictEqual(reply.details.hash, init!.hash);
    assert.strictEqual(reply.details.message, 'init');
  });

  test('changedFiles replies with the hash and the files from the command', async () => {
    const replies: unknown[] = [];
    const calls: unknown[][] = [];
    const files = [{ status: 'A', path: 'a.txt', binary: false }];
    await handleMessage({ type: 'changedFiles', hash: 'abc123' }, (r) => replies.push(r), async (...args) => {
      calls.push(args);
      return files;
    });
    assert.deepStrictEqual(calls, [['stagehand.history.changedFiles', 'abc123']]);
    assert.deepStrictEqual(replies, [{ type: 'changedFiles', hash: 'abc123', files }]);
  });

  test('changedFiles through the real command replies with the files of init', async () => {
    const init = await commitNamed('init');
    const replies: unknown[] = [];
    await handleMessage({ type: 'changedFiles', hash: init!.hash }, (r) => replies.push(r));
    assert.deepStrictEqual(replies, [{ type: 'changedFiles', hash: init!.hash, files: [{ status: 'A', path: 'file.txt', binary: false }] }]);
  });

  test('changedFiles with a list of hashes through the real command replies with the combined list', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    const replies: unknown[] = [];
    const hashes = [modify.hash, init.hash];
    await handleMessage({ type: 'changedFiles', hash: hashes }, (r) => replies.push(r));
    assert.deepStrictEqual(replies, [{ type: 'changedFiles', hash: hashes, files: [{ status: 'A', path: 'file.txt', binary: false, target: modify.hash }], gap: 0 }]);
  });

  test('changedFiles with a list of hashes passes the gap and the different-branches error through to the webview', async () => {
    const replies: unknown[] = [];
    const results = [{ files: [], gap: 3 }, { files: [], gap: 0, error: "Selected commits are on different branches; can't combine" }];
    for (const result of results) await handleMessage({ type: 'changedFiles', hash: ['a1', 'b2'] }, (r) => replies.push(r), async () => result);
    assert.deepStrictEqual(replies, results.map((r) => ({ type: 'changedFiles', hash: ['a1', 'b2'], ...r })));
  });

  test('openDiff runs the command with hash, file and preview, and posts no reply', async () => {
    const calls: unknown[][] = [];
    const file = { status: 'M', path: 'a.txt', binary: false };
    await handleMessage({ type: 'openDiff', hash: 'abc123', file, preview: false }, () => assert.fail('no reply'), async (...args) => {
      calls.push(args);
    });
    assert.deepStrictEqual(calls, [['stagehand.history.openDiff', 'abc123', file, false]]);
  });

  test('openDiff through the real command opens the diff tab', async () => {
    const modify = await commitNamed('modify');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = { status: 'M', path: 'file.txt', binary: false };
    await handleMessage({ type: 'openDiff', hash: modify.hash, file, preview: true }, () => assert.fail('no reply'));
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
  });

  test('copy writes the text to the clipboard', async () => {
    await vscode.env.clipboard.writeText('');
    await handleMessage({ type: 'copy', text: 'abc123' }, () => assert.fail('copy posts no reply'));
    assert.strictEqual(await vscode.env.clipboard.readText(), 'abc123');
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

// Runs last: moves HEAD around, then leaves the workspace repo on integration-branch again.
suite('checkout', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir(), encoding: 'utf8' }).trim();
  const branch = () => vscode.commands.executeCommand<string | undefined>('stagehand.showCurrentBranch');
  suiteTeardown(() => {
    git('checkout', '-q', 'integration-branch');
  });

  test('checking out the earlier commit detaches HEAD there; the integration-branch tip gets the branch back', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    assert.strictEqual(await vscode.commands.executeCommand('stagehand.history.checkout', init.hash), true);
    assert.strictEqual(git('rev-parse', 'HEAD'), init.hash);
    assert.strictEqual(await branch(), undefined);
    assert.strictEqual(await vscode.commands.executeCommand('stagehand.history.checkout', modify.hash), true);
    assert.strictEqual(await branch(), 'integration-branch');
  });

  test('a commit that is the tip of several branches asks which one; cancelling changes nothing', async () => {
    const modify = await commitNamed('modify');
    git('branch', 'other-branch', modify.hash);
    try {
      const offered: string[][] = [];
      const ui = (answer: string | undefined) => ({ pick: async (b: string[]) => (offered.push(b), answer), error: () => assert.fail('no error'), confirmStash: async () => assert.fail('no modal'), warn: () => assert.fail('no warning') });
      assert.strictEqual(await checkout(modify.hash, ui(undefined)), false);
      assert.strictEqual(await branch(), 'integration-branch');
      assert.strictEqual(await checkout(modify.hash, ui('other-branch')), true);
      assert.strictEqual(await branch(), 'other-branch');
      assert.deepStrictEqual(offered, [['integration-branch', 'other-branch'], ['integration-branch', 'other-branch']]);
    } finally {
      git('checkout', '-q', 'integration-branch');
      git('branch', '-D', 'other-branch');
    }
  });

  const noUi = { pick: async () => assert.fail('no pick'), confirmStash: async () => assert.fail('no modal'), error: () => assert.fail('no error'), warn: () => assert.fail('no warning') };

  test('a checkout refused for another reason shows git\'s reason and changes nothing', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    const lock = join(repoDir(), '.git', 'index.lock');
    writeFileSync(lock, '');
    try {
      const errors: string[] = [];
      assert.strictEqual(await checkout(init.hash, { ...noUi, error: (m) => errors.push(m) }), false);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0]!, /index\.lock/);
      assert.strictEqual(git('rev-parse', 'HEAD'), modify.hash);
    } finally {
      rmSync(lock);
    }
  });

  test('uncommitted changes in the way open the Stash & Checkout modal; Cancel changes nothing', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    const file = join(repoDir(), 'file.txt');
    writeFileSync(file, 'dirty\n');
    try {
      const reasons: string[] = [];
      assert.strictEqual(await checkout(init.hash, { ...noUi, confirmStash: async (r) => (reasons.push(r), false) }), false);
      assert.strictEqual(reasons.length, 1);
      assert.match(reasons[0]!, /file\.txt/);
      assert.strictEqual(git('rev-parse', 'HEAD'), modify.hash);
      assert.strictEqual(await branch(), 'integration-branch');
      assert.strictEqual(readFileSync(file, 'utf8'), 'dirty\n');
      assert.strictEqual(git('stash', 'list'), '');
    } finally {
      git('checkout', '-q', '--', 'file.txt');
    }
  });

  test('choosing Stash & Checkout moves HEAD; conflicting changes are kept in the stash and the user is told', async () => {
    const init = await commitNamed('init');
    const file = join(repoDir(), 'file.txt');
    writeFileSync(file, 'dirty\n');
    try {
      const warnings: string[] = [];
      assert.strictEqual(await checkout(init.hash, { ...noUi, confirmStash: async () => true, warn: (m) => warnings.push(m) }), true);
      assert.strictEqual(git('rev-parse', 'HEAD'), init.hash);
      assert.deepStrictEqual(warnings, [STASH_KEPT]);
      assert.strictEqual(git('show', 'stash@{0}:file.txt'), 'dirty');
    } finally {
      git('reset', '-q', '--hard');
      git('stash', 'drop', '-q');
      git('checkout', '-q', 'integration-branch');
    }
  });

  test('the checkout command with stashAndCheckout: true skips the modal; HEAD moves and the change survives', async () => {
    const init = await commitNamed('init');
    const file = join(repoDir(), 'file.txt');
    const untracked = join(repoDir(), 'untracked.txt');
    writeFileSync(file, 'dirty\n');
    writeFileSync(untracked, 'mine\n');
    try {
      assert.strictEqual(await vscode.commands.executeCommand('stagehand.history.checkout', init.hash, { stashAndCheckout: true }), true);
      assert.strictEqual(git('rev-parse', 'HEAD'), init.hash);
      // file.txt conflicts with init, so the change is kept in the stash; the untracked file comes back.
      assert.strictEqual(git('show', 'stash@{0}:file.txt'), 'dirty');
      assert.match(readFileSync(file, 'utf8'), /dirty/);
      assert.strictEqual(readFileSync(untracked, 'utf8'), 'mine\n');
    } finally {
      git('reset', '-q', '--hard');
      git('stash', 'drop', '-q');
      rmSync(untracked, { force: true });
      git('checkout', '-q', 'integration-branch');
    }
  });

  test('a checkout message runs the command and reposts the commits so the HEAD marker moves', async () => {
    const [init, modify] = [await commitNamed('init'), await commitNamed('modify')];
    const replies: { type: string; commits?: Commit[] }[] = [];
    await handleMessage({ type: 'checkout', hash: init.hash }, (r) => replies.push(r as { type: string }));
    assert.deepStrictEqual(replies.map((r) => r.type), ['commits']);
    // Both commits share a timestamp, so match by hash rather than list order.
    const refs = (r: { commits?: Commit[] }) => Object.fromEntries(r.commits!.map((c) => [c.hash, c.refs]));
    assert.deepStrictEqual(refs(replies[0]!), { [init.hash]: ['HEAD'], [modify.hash]: ['integration-branch'] });
    await handleMessage({ type: 'checkout', hash: modify.hash }, (r) => replies.push(r as { type: string }));
    assert.deepStrictEqual(refs(replies[1]!), { [init.hash]: [], [modify.hash]: ['HEAD -> integration-branch'] });
  });

  test('a refused checkout message posts nothing', async () => {
    await handleMessage({ type: 'checkout', hash: 'abc123' }, () => assert.fail('no reply'), async () => false);
  });
});
