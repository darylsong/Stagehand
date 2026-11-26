import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  branchesContaining, changedFiles, checkout as gitCheckout, checkoutTarget, smartCheckout, STASH_KEPT, type CheckoutRefused, combinedChanges, commitDetails, currentBranch, fileAtRevision, firstParent, gitError, listCommits, revert, revertAbort, revertContinue, revertState, type ChangedFile, type ErrorKind,
} from '../core/git';

/** The first workspace folder's path; throws the 'no-folder' GitError when there is none. */
export function repoDir(folders = vscode.workspace.workspaceFolders): string {
  const folder = folders?.[0];
  if (!folder) throw gitError('no-folder');
  return folder.uri.fsPath;
}

/** Runs a command; defaults to VS Code's. Injectable so tests can make it fail. */
type Run = (command: string, ...args: unknown[]) => Thenable<unknown>;
const runCommand: Run = (command, ...args) => vscode.commands.executeCommand(command, ...args);

type WebviewMessage = {
  type: string; skip?: number; limit?: number; hash?: string | string[]; text?: string; file?: ChangedFile; preview?: boolean;
};

/** `stagehand:/<path>?<rev>`; an empty rev means the file doesn't exist on that side. */
const revUri = (rev: string | undefined, path: string) => vscode.Uri.from({ scheme: 'stagehand', path: `/${path}`, query: rev ?? '' });

/** Opens the parent→commit diff of one changed file (base→target for a combined list). Binary files open nothing. */
export async function openDiff(hash: string, file: ChangedFile, preview = true): Promise<void> {
  if (file.binary) return;
  if (file.target) {
    const title = `${basename(file.path)} (${file.base?.slice(0, 8) ?? 'empty'}..${file.target.slice(0, 8)})`;
    await vscode.commands.executeCommand('vscode.diff', revUri(file.base, file.path), revUri(file.target, file.path), title, { preview });
    return;
  }
  const parent = await firstParent(repoDir(), hash);
  // Added/deleted files: fileAtRevision returns '' for the side where the path doesn't exist.
  const left = revUri(parent, file.oldPath ?? file.path);
  const right = revUri(hash, file.path);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(file.path)} (${hash.slice(0, 8)})`, { preview });
}

/** UI the checkout command uses; injectable so integration tests can answer the quick pick and the modal, and see messages. */
export type CheckoutUi = {
  pick: (branches: string[]) => Thenable<string | undefined>;
  /** Modal: Stash & Checkout (true) or Cancel (false). `reason` is git's refusal. */
  confirmStash: (reason: string) => Thenable<boolean>;
  error: (message: string) => unknown;
  warn: (message: string) => unknown;
};
const STASH_AND_CHECKOUT = 'Stash & Checkout';
const checkoutUi: CheckoutUi = {
  pick: (branches) => vscode.window.showQuickPick(branches, { placeHolder: 'Several branches point at this commit; check out which?' }),
  // Modal dialogs add Cancel themselves (resolves undefined).
  confirmStash: (reason) => vscode.window
    .showWarningMessage('Your uncommitted changes would be overwritten by checkout.', { modal: true, detail: reason }, STASH_AND_CHECKOUT)
    .then((choice) => choice === STASH_AND_CHECKOUT),
  error: (message) => vscode.window.showErrorMessage(`Checkout failed: ${message}`),
  warn: (message) => vscode.window.showWarningMessage(message),
};

/**
 * Checks out the commit's branch (picking if several), or the commit itself detached. Returns whether HEAD moved.
 * If uncommitted changes are in the way, offers Stash & Checkout; `stashAndCheckout: true` answers that without the modal.
 */
export async function checkout(hash: string, ui: CheckoutUi = checkoutUi, { stashAndCheckout = false } = {}): Promise<boolean> {
  const dir = repoDir();
  const target = await checkoutTarget(dir, hash);
  const branch = typeof target === 'string' ? undefined : target.length > 1 ? await ui.pick(target) : target[0];
  if (typeof target !== 'string' && !branch) return false; // quick pick cancelled
  const to = branch ? { branch } : { detach: hash };
  try {
    await gitCheckout(dir, to);
    return true;
  } catch (err) {
    const refused = err as CheckoutRefused;
    if (!refused.localChanges) {
      ui.error(refused.message);
      return false;
    }
    if (!stashAndCheckout && !(await ui.confirmStash(refused.message))) return false; // Cancel: nothing touched
  }
  try {
    if ((await smartCheckout(dir, to)) === 'kept in stash') ui.warn(STASH_KEPT);
    return true;
  } catch (err) {
    ui.error((err as Error).message);
    return false;
  }
}

/** Handles one message from the webview; `post` sends the reply. */
export async function handleMessage(
  msg: WebviewMessage,
  post: (reply: unknown) => unknown,
  run: Run = runCommand,
): Promise<void> {
  try {
    if (msg.type === 'loadCommits') {
      const skip = msg.skip ?? 0;
      const limit = msg.limit ?? 1000;
      const commits = (await run('stagehand.history.loadCommits', { skip, limit })) ?? [];
      // A first page (load or refresh) also carries whether a revert is stopped, for the banner.
      const revertStoppedAt = skip === 0 ? await run('stagehand.history.revertState') : undefined;
      post({ type: 'commits', skip, limit, commits, ...(revertStoppedAt ? { revertStoppedAt } : {}) });
    } else if (msg.type === 'commitDetails') {
      post({ type: 'details', details: await run('stagehand.history.commitDetails', msg.hash) });
    } else if (msg.type === 'branchesContaining') {
      post({ type: 'branches', hash: msg.hash, branches: await run('stagehand.history.branchesContaining', msg.hash) });
    } else if (msg.type === 'changedFiles') {
      // A hash list returns combinedChanges' { files, gap, error? }; a single hash returns the files.
      const result = await run('stagehand.history.changedFiles', msg.hash);
      post({ type: 'changedFiles', hash: msg.hash, ...(Array.isArray(result) ? { files: result } : (result as object)) });
    } else if (msg.type === 'openDiff') {
      await run('stagehand.history.openDiff', msg.hash, msg.file, msg.preview);
    } else if (msg.type === 'checkout') {
      // Reload the first page so the HEAD marker moves.
      if (await run('stagehand.history.checkout', msg.hash)) {
        post({ type: 'commits', skip: 0, limit: 1000, commits: (await run('stagehand.history.loadCommits', { skip: 0, limit: 1000 })) ?? [] });
      }
    } else if (msg.type === 'revert' || msg.type === 'revertContinue' || msg.type === 'revertAbort') {
      try {
        await run(`stagehand.${msg.type}`, ...(msg.type === 'revert' ? [msg.hash] : []));
      } catch (err) {
        // A refusal changed nothing: show the reason, no reload.
        post({ type: 'revertError', message: (err as Error).message ?? String(err) });
        return;
      }
      post({ type: 'refresh' }); // the webview reloads (keeping its selection); the reply carries the banner state
    } else if (msg.type === 'copy') {
      await vscode.env.clipboard.writeText(String(msg.text ?? ''));
    }
  } catch (err) {
    // GitError carries its kind; anything else is a plain git failure shown as its text.
    const kind: ErrorKind = (err as { kind?: ErrorKind }).kind ?? 'git';
    post({ type: 'error', kind, message: (err as Error).message ?? String(err) });
  }
}

/** The view's HTML: index.html from `dir` with the script URI and a CSP filled in. */
export function webviewHtml(dir: string, scriptUri: string, cspSource: string): string {
  const file = join(dir, 'index.html');
  if (!existsSync(file)) {
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';">` +
      `<p>Stagehand: webview not built (${file} missing). Run <code>npm run compile</code>.</p>`;
  }
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource}; style-src 'unsafe-inline';">`;
  return readFileSync(file, 'utf8')
    .replace('<head>', `<head>\n  ${csp}`)
    .replace('src="main.js"', `src="${scriptUri}"`);
}

/** Calls `onChange` (debounced) when the repo's HEAD, refs or packed-refs change. */
export function watchRepo(dir: string, onChange: () => unknown, delay = 300): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '.git/{HEAD,packed-refs,refs/**}'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  };
  watcher.onDidCreate(fire);
  watcher.onDidChange(fire);
  watcher.onDidDelete(fire);
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher.dispose();
  });
}

/** The history view: serves the webview, answers its messages, and tells it to refresh when the repo changes. */
export function historyView(webviewDir: vscode.Uri): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      const { webview } = view;
      webview.options = { enableScripts: true, localResourceRoots: [webviewDir] };
      const script = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
      webview.html = webviewHtml(webviewDir.fsPath, script.toString(), webview.cspSource);
      webview.onDidReceiveMessage((msg) => handleMessage(msg, (reply) => webview.postMessage(reply)));
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        const watcher = watchRepo(folder.uri.fsPath, () => webview.postMessage({ type: 'refresh' }));
        view.onDidDispose(() => watcher.dispose());
      }
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const webviewDir = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
  context.subscriptions.push(
    vscode.commands.registerCommand('stagehand.history.loadCommits', ({ skip = 0, limit = 1000 } = {}) =>
      listCommits(repoDir(), { skip, limit }),
    ),
    vscode.commands.registerCommand('stagehand.history.commitDetails', (hash: string) => commitDetails(repoDir(), hash)),
    vscode.commands.registerCommand('stagehand.history.branchesContaining', (hash: string) => branchesContaining(repoDir(), hash)),
    vscode.commands.registerCommand('stagehand.history.changedFiles', (hash: string | string[]) =>
      Array.isArray(hash) ? combinedChanges(repoDir(), hash) : changedFiles(repoDir(), hash)),
    vscode.commands.registerCommand('stagehand.history.openDiff', openDiff),
    vscode.commands.registerCommand('stagehand.history.checkout', (hash: string, options?: { stashAndCheckout?: boolean }) =>
      checkout(hash, checkoutUi, options)),
    vscode.commands.registerCommand('stagehand.revert', (hashes: string[]) => revert(repoDir(), hashes)),
    vscode.commands.registerCommand('stagehand.revertContinue', () => revertContinue(repoDir())),
    vscode.commands.registerCommand('stagehand.revertAbort', () => revertAbort(repoDir())),
    vscode.commands.registerCommand('stagehand.history.revertState', () => revertState(repoDir())),
    vscode.workspace.registerTextDocumentContentProvider('stagehand', {
      provideTextDocumentContent: (uri) => (uri.query ? fileAtRevision(repoDir(), uri.query, uri.path.slice(1)) : ''),
    }),
    vscode.window.registerWebviewViewProvider('stagehand.history', historyView(webviewDir)),
    vscode.commands.registerCommand('stagehand.showCurrentBranch', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage('Stagehand: open a folder first.');
        return undefined;
      }
      try {
        const branch = await currentBranch(folder.uri.fsPath);
        void vscode.window.showInformationMessage(branch ? `Current branch: ${branch}` : 'HEAD is detached');
        return branch;
      } catch (err) {
        void vscode.window.showErrorMessage(`Stagehand: ${(err as Error).message}`);
        return undefined;
      }
    }),
  );
}

export function deactivate(): void {}
