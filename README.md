# Stagehand

A VS Code extension for browsing git history, inspired by the git log in JetBrains Rider.

Stagehand adds a **History** view to the bottom panel. It shows every branch's commits with a branch graph, the selected commit's details and its changed files.

## Features

- Commit list with a branch graph, branch and tag labels and a HEAD marker. It loads in pages, so large histories scroll smoothly.
- Details pane with the full message, author, date, labels and the branches that contain the commit.
- Changed files as a collapsible folder tree. Click a file to open its diff.
- Multi-select commits (Cmd/Ctrl-click, Shift-click) to see their combined changes.
- Refreshes automatically when the repository changes.
- Context menu actions:
  - Checkout (offers Stash & Checkout when local changes are in the way)
  - Copy Revision Number (Cmd/Ctrl+C)
  - Compare with Local
  - Revert and Cherry-Pick, with Continue/Abort when they stop on a conflict
  - Edit Commit Message (F2)
  - New Branch and New Tag
  - Go to Parent / Child Commit (Left/Right arrows)
  - Reset Current Branch to Here (Mixed, Soft or Keep; never Hard)
  - Undo Commit

## Development

Requires Node.js and git.

```sh
npm install
npm run compile   # build the extension and the webview into out/
```

Press F5 in VS Code to launch an Extension Development Host. It asks which repository to open. Use a throwaway clone, because actions like checkout and reset change that repository.

### Project layout

| Path | Contents |
| --- | --- |
| `src/core/` | Git logic: runs the git CLI and parses its output. No `vscode` imports. |
| `src/extension/` | The VS Code layer: commands, the webview view and the message handler. |
| `src/webview/` | The history view UI, bundled with esbuild. Open `out/webview/index.html` in a browser to view it on its own. |
| `src/test/` | Integration tests that run inside VS Code. |

### Tests

```sh
npm run verify   # typecheck, lint, unit, webview and integration tests
```

- `npm run test:unit`: vitest tests in `src/core`, run against temporary git repos.
- `npm run test:webview`: Playwright tests for the webview. Screenshots are saved to `test-results/screenshots/`.
- `npm run test:integration`: mocha tests in a real VS Code instance, via `@vscode/test-cli`.
