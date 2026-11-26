import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChangedFile, Commit, CommitDetails } from '../core/git';
import { gitError, REVERT_DIRTY, STASH_KEPT } from '../core/git';
import { checkout, handleMessage, historyView, repoDir, watchRepo, webviewHtml } from '../extension/extension';

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

  test('branchesContaining returns the branches that contain the init commit', async () => {
    const init = await commitNamed('init');
    assert.deepStrictEqual(await vscode.commands.executeCommand('stagehand.history.branchesContaining', init!.hash), ['integration-branch']);
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
    const reply = replies[0] as { type: string; skip: number; limit: number; commits: Commit[] };
    assert.strictEqual(reply.type, 'commits');
    assert.strictEqual(reply.skip, 0);
    assert.strictEqual(reply.limit, 1000); // the webview tells "end of history" from a reply shorter than its limit
    assert.deepStrictEqual(reply.commits.map((c) => c.subject), ['modify', 'init']);
    // Labels and the HEAD marker reach the webview as refs.
    assert.deepStrictEqual(reply.commits.map((c) => c.refs), [['HEAD -> refs/heads/integration-branch'], []]);
  });

  test('loadCommits includes commits reachable only from a remote-tracking branch or only from a tag', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repoDir() }).toString().trim();
    const tree = git('rev-parse', 'HEAD^{tree}');
    const remoteOnly = git('commit-tree', tree, '-p', 'HEAD', '-m', 'remote only');
    const tagOnly = git('commit-tree', tree, '-p', 'HEAD', '-m', 'tag only');
    git('update-ref', 'refs/remotes/origin/integration-remote', remoteOnly);
    git('tag', 'integration-tag-only', tagOnly);
    try {
      const replies: unknown[] = [];
      await handleMessage({ type: 'loadCommits', skip: 0, limit: 1000 }, (r) => replies.push(r));
      const { commits } = replies[0] as { commits: Commit[] };
      const refsOf = (hash: string) => commits.find((c) => c.hash === hash)?.refs;
      assert.deepStrictEqual(refsOf(remoteOnly), ['refs/remotes/origin/integration-remote']);
      assert.deepStrictEqual(refsOf(tagOnly), ['tag: refs/tags/integration-tag-only']);
      assert.strictEqual(commits.length, 4);
    } finally {
      git('update-ref', '-d', 'refs/remotes/origin/integration-remote');
      git('tag', '-d', 'integration-tag-only');
    }
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

  test('branchesContaining replies with the hash and the branches from the command', async () => {
    const init = await commitNamed('init');
    const replies: unknown[] = [];
    await handleMessage({ type: 'branchesContaining', hash: init!.hash }, (r) => replies.push(r));
    assert.deepStrictEqual(replies, [{ type: 'branches', hash: init!.hash, branches: ['integration-branch'] }]);
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

  test('stagehand.copyRevision puts the hashes, space-joined, on the clipboard and says Copied in the status bar', async () => {
    const statusBar = vscode.window.setStatusBarMessage;
    const shown: unknown[] = [];
    (vscode.window as { setStatusBarMessage: unknown }).setStatusBarMessage = (...args: unknown[]) => {
      shown.push(args[0]);
      return { dispose() {} };
    };
    try {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('stagehand.copyRevision', ['a'.repeat(40), 'b'.repeat(40)]);
      assert.strictEqual(await vscode.env.clipboard.readText(), `${'a'.repeat(40)} ${'b'.repeat(40)}`);
      assert.deepStrictEqual(shown, ['Copied']);
    } finally {
      (vscode.window as { setStatusBarMessage: unknown }).setStatusBarMessage = statusBar;
    }
  });

  test('a copyRevision message runs stagehand.copyRevision with the hashes', async () => {
    await vscode.env.clipboard.writeText('');
    await handleMessage({ type: 'copyRevision', hash: ['c'.repeat(40), 'd'.repeat(40)] }, () => assert.fail('no reply'));
    assert.strictEqual(await vscode.env.clipboard.readText(), `${'c'.repeat(40)} ${'d'.repeat(40)}`);
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
    assert.deepStrictEqual(refs(replies[0]!), { [init.hash]: ['HEAD'], [modify.hash]: ['refs/heads/integration-branch'] });
    await handleMessage({ type: 'checkout', hash: modify.hash }, (r) => replies.push(r as { type: string }));
    assert.deepStrictEqual(refs(replies[1]!), { [init.hash]: [], [modify.hash]: ['HEAD -> refs/heads/integration-branch'] });
  });

  test('a refused checkout message posts nothing', async () => {
    await handleMessage({ type: 'checkout', hash: 'abc123' }, () => assert.fail('no reply'), async () => false);
  });
});

suite('refresh when the repository changes', function () {
  this.timeout(20000); // waits on the file watcher
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir(), encoding: 'utf8' }).trim();
  const commitEmpty = (msg: string) => git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);
  const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await ok()) return;
    assert.fail(`timed out waiting for ${what}`);
  };
  const first = async () => (await vscode.commands.executeCommand<Commit[]>('stagehand.history.loadCommits', { skip: 0, limit: 1000 }))[0]!.subject;
  let disposables: vscode.Disposable[] = [];
  let tip = '';
  setup(() => {
    tip = git('rev-parse', 'HEAD');
  });
  teardown(() => {
    disposables.forEach((d) => d.dispose());
    disposables = [];
    git('reset', '-q', '--soft', tip); // drop the test commits
    git('tag', '-d', 'watched-tag');
  });

  test('a commit plus a tag (two ref files) fire the watcher once (debounced); loadCommits returns the commit first', async () => {
    let fired = 0;
    disposables.push(watchRepo(repoDir(), () => fired++));
    await new Promise((r) => setTimeout(r, 1000)); // let the watcher start and earlier suites' ref changes arrive
    fired = 0;
    commitEmpty('watched commit');
    git('tag', 'watched-tag');
    await until('the watcher', () => fired > 0);
    await until('loadCommits to return the new commit first', async () => (await first()) === 'watched commit');
    await new Promise((r) => setTimeout(r, 1000));
    assert.strictEqual(fired, 1);
  });

  test('the history view posts refresh to its webview when the repo changes, and its loadCommits replies carry the new commit', async () => {
    const posted: { type: string; commits?: Commit[] }[] = [];
    let receive: (msg: unknown) => unknown = () => undefined;
    const webview = {
      options: {}, html: '', cspSource: 'csp',
      asWebviewUri: (u: vscode.Uri) => u,
      onDidReceiveMessage: (cb: (msg: unknown) => unknown) => { receive = cb; },
      postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
    };
    const view = { webview, onDidDispose: (cb: () => void) => disposables.push(new vscode.Disposable(cb)) };
    historyView(vscode.Uri.file(resolve('out/webview'))).resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, new vscode.CancellationTokenSource().token);
    await new Promise((r) => setTimeout(r, 500));
    commitEmpty('view refresh commit');
    git('tag', 'watched-tag');
    await until('the refresh message', () => posted.some((m) => m.type === 'refresh'));
    // The webview answers refresh with loadCommits; the reply starts with the new commit.
    await receive({ type: 'loadCommits', skip: 0, limit: 1000 });
    await until('the commits reply', () => posted.some((m) => m.type === 'commits'));
    assert.strictEqual(posted.find((m) => m.type === 'commits')!.commits![0]!.subject, 'view refresh commit');
  });
});

suite('revert', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir(), encoding: 'utf8', stdio: 'pipe' }).trim();
  const file = () => join(repoDir(), 'file.txt');
  let tip = '';
  suiteSetup(() => {
    // revert commits, so the temp repo needs an identity of its own (not the machine's).
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    git('config', 'commit.gpgsign', 'false');
  });
  setup(() => {
    tip = git('rev-parse', 'HEAD');
  });
  teardown(() => {
    try {
      git('revert', '--abort');
    } catch {
      // no revert in progress
    }
    git('reset', '-q', '--hard', tip);
  });
  const replies = async (msg: Parameters<typeof handleMessage>[0]) => {
    const posted: { type: string; message?: string; revertStoppedAt?: string }[] = [];
    await handleMessage(msg, (r) => posted.push(r as { type: string }));
    return posted;
  };
  const stoppedAt = async () => (await replies({ type: 'loadCommits', skip: 0, limit: 1000 }))[0]!.revertStoppedAt;

  test('stagehand.revert creates one revert commit per commit, newest first, with git\'s message', async () => {
    const modify = await commitNamed('modify');
    // Passed oldest first; other must be reverted first.
    writeFileSync(join(repoDir(), 'other.txt'), 'other\n');
    git('add', 'other.txt');
    git('commit', '-q', '-m', 'other');
    const other = git('rev-parse', 'HEAD');
    assert.strictEqual(await vscode.commands.executeCommand('stagehand.revert', [modify.hash, other]), undefined);
    assert.deepStrictEqual(git('log', '-3', '--format=%s').split('\n'), ['Revert "modify"', 'Revert "other"', 'other']);
    assert.strictEqual(git('log', '-1', '--format=%b'), `This reverts commit ${modify.hash}.`);
    assert.strictEqual(readFileSync(file(), 'utf8'), 'old\n');
  });

  test('the webview\'s revert message reloads on success; refusals post their reason and change nothing', async () => {
    const modify = await commitNamed('modify');
    const other = git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', git('rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'elsewhere');
    assert.deepStrictEqual(await replies({ type: 'revert', hash: [other] }),
      [{ type: 'revertError', message: `Can't revert: ${other.slice(0, 8)} isn't in the current branch` }]);
    writeFileSync(file(), 'dirty\n');
    assert.deepStrictEqual(await replies({ type: 'revert', hash: [modify.hash] }), [{ type: 'revertError', message: REVERT_DIRTY }]);
    assert.strictEqual(git('rev-parse', 'HEAD'), tip);
    assert.strictEqual(readFileSync(file(), 'utf8'), 'dirty\n');
    git('checkout', '--', 'file.txt');
    assert.deepStrictEqual(await replies({ type: 'revert', hash: [modify.hash] }), [{ type: 'refresh' }]);
    assert.strictEqual(git('log', '-1', '--format=%s'), 'Revert "modify"');
  });

  test('a conflict: the first-page reply names the stopping commit until Abort restores HEAD', async () => {
    const init = await commitNamed('init');
    assert.strictEqual(await stoppedAt(), undefined);
    assert.deepStrictEqual(await replies({ type: 'revert', hash: [init.hash] }), [{ type: 'refresh' }]);
    assert.strictEqual(await stoppedAt(), init.hash);
    assert.strictEqual(await stoppedAt(), init.hash); // read from disk each time (survives a reload)
    assert.deepStrictEqual(await replies({ type: 'revertAbort' }), [{ type: 'refresh' }]);
    assert.strictEqual(await stoppedAt(), undefined);
    assert.strictEqual(git('rev-parse', 'HEAD'), tip);
  });

  test('a conflict: Continue refuses while unresolved, then commits the revert; resolving in a terminal clears the state', async () => {
    const init = await commitNamed('init');
    await replies({ type: 'revert', hash: [init.hash] });
    const refused = await replies({ type: 'revertContinue' });
    assert.strictEqual(refused[0]!.type, 'revertError');
    assert.strictEqual(await stoppedAt(), init.hash);
    git('rm', '-q', 'file.txt');
    assert.deepStrictEqual(await replies({ type: 'revertContinue' }), [{ type: 'refresh' }]); // GIT_EDITOR=true: no editor waits
    assert.strictEqual(git('log', '-1', '--format=%s'), 'Revert "init"');
    assert.strictEqual(await stoppedAt(), undefined);
    // Resolved elsewhere: a terminal abort clears it on the next first page.
    git('reset', '-q', '--hard', tip);
    await replies({ type: 'revert', hash: [init.hash] });
    assert.strictEqual(await stoppedAt(), init.hash);
    git('revert', '--abort');
    assert.strictEqual(await stoppedAt(), undefined);
  });
});
