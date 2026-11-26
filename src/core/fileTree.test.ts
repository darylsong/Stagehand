import { expect, test } from 'vitest';
import { fileTree, type TreeNode } from './fileTree';
import type { ChangedFile } from './git';

const f = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ status: 'M', path, binary: false, ...extra });
/** Compact view: folders as "name (count)" with children, files as their name. */
const show = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.kind === 'file' ? n.name : { [`${n.name} (${n.count})`]: show(n.children) }));

test('folders first, then files, sorted; counts include every file below', () => {
  const tree = fileTree([f('README.md'), f('src/b.ts'), f('src/a.ts'), f('docs/x.md'), f('src/sub/c.ts'), f('a.txt')]);
  expect(show(tree)).toEqual([
    { 'docs (1)': ['x.md'] },
    { 'src (3)': [{ 'sub (1)': ['c.ts'] }, 'a.ts', 'b.ts'] },
    'README.md', 'a.txt',
  ]);
  const src = tree[1]!;
  expect(src.kind === 'folder' && src.path).toBe('src');
});

test('single-child folder chains merge into one line, at any depth', () => {
  const tree = fileTree([f('src/core/deep/x.ts'), f('src/core/deep/y.ts'), f('src/webview/a/b/z.ts'), f('src/webview/w.ts')]);
  expect(show(tree)).toEqual([
    { 'src (4)': [
      { 'core/deep (2)': ['x.ts', 'y.ts'] },
      { 'webview (2)': [{ 'a/b (1)': ['z.ts'] }, 'w.ts'] },
    ] },
  ]);
  const webview = (tree[0] as { children: TreeNode[] }).children[1]!;
  const ab = webview.kind === 'folder' ? webview.children[0]! : undefined;
  expect(ab?.kind === 'folder' && ab.path).toBe('src/webview/a/b');
  // A lone file keeps its folder line (only folder chains merge).
  expect(show(fileTree([f('a/b/c.txt')]))).toEqual([{ 'a/b (1)': ['c.txt'] }]);
});

test('renames sit at the new path; the old name shows short in the same folder, in full when it moved', () => {
  const same = f('src/after.ts', { status: 'R', oldPath: 'src/before.ts' });
  const moved = f('lib/x.ts', { status: 'R', oldPath: 'old/dir/x.ts' });
  const bin = f('img/logo.png', { status: 'A', binary: true });
  const tree = fileTree([same, moved, bin]);
  expect(show(tree)).toEqual([
    { 'img (1)': ['logo.png'] }, { 'lib (1)': ['old/dir/x.ts → x.ts'] }, { 'src (1)': ['before.ts → after.ts'] },
  ]);
  // The original ChangedFile is kept untouched for opening diffs.
  const leaf = (n: TreeNode) => (n.kind === 'folder' ? n.children[0]! : n);
  expect(tree.map((n) => (leaf(n) as { file: ChangedFile }).file)).toEqual([bin, moved, same]);
  expect(fileTree([])).toEqual([]);
});
