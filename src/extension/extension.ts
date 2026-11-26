import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { currentBranch, listCommits } from '../core/git';

function repoDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No folder open');
  return folder.uri.fsPath;
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
        webview.html = readFileSync(vscode.Uri.joinPath(webviewDir, 'index.html').fsPath, 'utf8')
          .replace('src="main.js"', `src="${script.toString()}"`);
        webview.onDidReceiveMessage(async (msg: { type: string; skip?: number; limit?: number }) => {
          if (msg.type !== 'loadCommits') return;
          try {
            const commits = await vscode.commands.executeCommand('stagehand.history.loadCommits', msg);
            void webview.postMessage({ type: 'commits', skip: msg.skip ?? 0, commits });
          } catch (err) {
            // ponytail: raw error text; distinct empty/error states come in issue 002.
            void webview.postMessage({ type: 'error', message: (err as Error).message });
          }
        });
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
