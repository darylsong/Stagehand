import type { ChangedFile } from './git';

export interface FolderNode { kind: 'folder'; name: string; path: string; count: number; children: TreeNode[] }
/** `name` is what the row shows: the file name, or `old → new` for a rename (old as a full path if it moved folders). */
export interface FileNode { kind: 'file'; name: string; file: ChangedFile }
export type TreeNode = FolderNode | FileNode;

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Changed files → folder tree: folders first, then files, each by name; single-child folder chains merged into one `a/b/c` node; count = files below. */
export function fileTree(files: ChangedFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', count: 0, children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    dir.count++;
    for (const part of parts.slice(0, -1)) {
      // ponytail: linear scan per level; fine for commit-sized lists, use a Map if 10k-file commits get slow.
      let next = dir.children.find((c): c is FolderNode => c.kind === 'folder' && c.name === part);
      if (!next) {
        next = { kind: 'folder', name: part, path: dir.path ? `${dir.path}/${part}` : part, count: 0, children: [] };
        dir.children.push(next);
      }
      dir = next;
      dir.count++;
    }
    const old = f.oldPath && (dirOf(f.oldPath) === dirOf(f.path) ? baseOf(f.oldPath) : f.oldPath);
    dir.children.push({ kind: 'file', name: old ? `${old} → ${parts.at(-1)}` : parts.at(-1)!, file: f });
  }
  return tidy(root.children);
}

function tidy(nodes: TreeNode[]): TreeNode[] {
  const key = (n: TreeNode) => (n.kind === 'folder' ? `0${n.name}` : `1${baseOf(n.file.path)}`);
  return nodes.map((n) => {
    if (n.kind === 'file') return n;
    let folder = n;
    for (let only = folder.children[0]; folder.children.length === 1 && only?.kind === 'folder'; only = folder.children[0]) {
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    return { ...folder, children: tidy(folder.children) };
  }).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)); // code-unit order: the same on every locale
}
