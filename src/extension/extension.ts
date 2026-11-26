import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, commitDetails, currentBranch, listCommits } from '../core/git';

function repoDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No folder open');
  return folder.uri.fsPath;
}

/** Runs a command; defaults to VS Code's. Injectable so tests can make it fail. */
type Run = (command: string, ...args: unknown[]) => Thenable<unknown>;
const runCommand: Run = (command, ...args) => vscode.commands.executeCommand(command, ...args);

type WebviewMessage = { type: string; skip?: number; limit?: number; hash?: string; text?: string };

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
      post({ type: 'changedFiles', hash: msg.hash, files: await run('stagehand.history.changedFiles', msg.hash) });
    } else if (msg.type === 'copy') {
      await vscode.env.clipboard.writeText(String(msg.text ?? ''));
    }
  } catch (err) {
    // ponytail: raw error text; distinct empty/error states come in issue 002.
    post({ type: 'error', message: (err as Error).message });
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
    vscode.commands.registerCommand('stagehand.history.changedFiles', (hash: string) => changedFiles(repoDir(), hash)),
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
