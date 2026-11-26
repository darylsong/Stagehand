import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, listCommits, type Commit } from '../core/git';

function repoDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No folder open');
  return folder.uri.fsPath;
}

type Load = (opts: { skip: number; limit: number }) => Promise<Commit[]>;
const loadFromCommand: Load = async (opts) =>
  (await vscode.commands.executeCommand<Commit[]>('stagehand.history.loadCommits', opts)) ?? [];

/** Handles one message from the webview; `post` sends the reply. `load` is injectable for tests. */
export async function handleMessage(
  msg: { type: string; skip?: number; limit?: number },
  post: (reply: unknown) => unknown,
  load: Load = loadFromCommand,
): Promise<void> {
  if (msg.type !== 'loadCommits') return;
  const skip = msg.skip ?? 0;
  try {
    post({ type: 'commits', skip, commits: await load({ skip, limit: msg.limit ?? 1000 }) });
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
