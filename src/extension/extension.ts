import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  changedFiles, combinedChanges, commitDetails, currentBranch, fileAtRevision, firstParent, gitError, listCommits, type ChangedFile, type ErrorKind,
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

/** Handles one message from the webview; `post` sends the reply. */
export async function handleMessage(
  msg: WebviewMessage,
  post: (reply: unknown) => unknown,
  run: Run = runCommand,
): Promise<void> {
  try {
    if (msg.type === 'loadCommits') {
      const skip = msg.skip ?? 0;
      const commits = (await run('stagehand.history.loadCommits', { skip, limit: msg.limit ?? 1000 })) ?? [];
      post({ type: 'commits', skip, commits });
    } else if (msg.type === 'commitDetails') {
      post({ type: 'details', details: await run('stagehand.history.commitDetails', msg.hash) });
    } else if (msg.type === 'changedFiles') {
      // A hash list returns combinedChanges' { files, gap, error? }; a single hash returns the files.
      const result = await run('stagehand.history.changedFiles', msg.hash);
      post({ type: 'changedFiles', hash: msg.hash, ...(Array.isArray(result) ? { files: result } : (result as object)) });
    } else if (msg.type === 'openDiff') {
      await run('stagehand.history.openDiff', msg.hash, msg.file, msg.preview);
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

export function activate(context: vscode.ExtensionContext): void {
  const webviewDir = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
  context.subscriptions.push(
    vscode.commands.registerCommand('stagehand.history.loadCommits', ({ skip = 0, limit = 1000 } = {}) =>
      listCommits(repoDir(), { skip, limit }),
    ),
    vscode.commands.registerCommand('stagehand.history.commitDetails', (hash: string) => commitDetails(repoDir(), hash)),
    vscode.commands.registerCommand('stagehand.history.changedFiles', (hash: string | string[]) =>
      Array.isArray(hash) ? combinedChanges(repoDir(), hash) : changedFiles(repoDir(), hash)),
    vscode.commands.registerCommand('stagehand.history.openDiff', openDiff),
    vscode.workspace.registerTextDocumentContentProvider('stagehand', {
      provideTextDocumentContent: (uri) => (uri.query ? fileAtRevision(repoDir(), uri.query, uri.path.slice(1)) : ''),
    }),
    vscode.window.registerWebviewViewProvider('stagehand.history', {
      resolveWebviewView(view) {
        const { webview } = view;
        webview.options = { enableScripts: true, localResourceRoots: [webviewDir] };
        const script = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
        webview.html = webviewHtml(webviewDir.fsPath, script.toString(), webview.cspSource);
        webview.onDidReceiveMessage((msg) => handleMessage(msg, (reply) => webview.postMessage(reply)));
      },
    }),
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
