import type { ChangedFile, Commit, CommitDetails } from '../core/git';

export type Message =
  | { type: 'commits'; skip: number; commits: Commit[] }
  | { type: 'details'; details: CommitDetails }
  | { type: 'changedFiles'; hash: string; files: ChangedFile[] }
  | { type: 'error'; message: string };

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
// Standalone (browser/Playwright) there is no VS Code API; tests post messages directly.
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const post = (msg: unknown) => vscode?.postMessage(msg);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
];

export function relativeDate(iso: string, now = Date.now()): string {
  const secs = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  return rtf.format(0, 'second');
}

function cell(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

let commits: Commit[] = [];
let selected = -1;

function select(list: HTMLElement, i: number): void {
  if (i < 0 || i >= commits.length || i === selected) return;
  list.children[selected]?.classList.remove('selected');
  list.children[selected]?.setAttribute('aria-selected', 'false');
  selected = i;
  const row = list.children[i] as HTMLElement;
  row.classList.add('selected');
  row.setAttribute('aria-selected', 'true');
  row.scrollIntoView({ block: 'nearest' });
  const hash = commits[i]!.hash;
  post({ type: 'commitDetails', hash });
  post({ type: 'changedFiles', hash });
}

function field(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'field';
  el.append(cell('label', label), cell(`value ${label.toLowerCase()}-value`, value));
  return el;
}

function renderFiles(el: HTMLElement, hash: string, files: ChangedFile[]): void {
  el.replaceChildren(...files.map((f) => {
    const row = document.createElement('div');
    row.className = 'file';
    row.tabIndex = 0;
    row.append(cell(`status status-${f.status}`, f.status), cell('path', f.oldPath ? `${f.oldPath} → ${f.path}` : f.path));
    if (f.binary) {
      row.append(cell('binary', 'Binary file changed'));
      return row;
    }
    const open = (preview: boolean) => post({ type: 'openDiff', hash, file: f, preview });
    row.addEventListener('click', () => open(true));
    row.addEventListener('dblclick', () => open(false));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open(true);
    });
    return row;
  }));
}

function renderDetails(pane: HTMLElement, d: CommitDetails): void {
  const message = document.createElement('pre');
  message.className = 'full-message';
  message.textContent = d.message;
  const hash = field('Hash', d.hash);
  const copy = document.createElement('button');
  copy.className = 'copy';
  copy.textContent = 'Copy';
  copy.title = 'Copy full hash';
  copy.addEventListener('click', () => post({ type: 'copy', text: d.hash }));
  hash.append(copy);
  pane.replaceChildren(
    message,
    field('Author', `${d.authorName} <${d.authorEmail}>`),
    field('Date', new Date(d.authorDate).toLocaleString()),
    hash,
    field('Parents', d.parents.join(' ') || '(none)'),
  );
}

export function render(root: HTMLElement, msg: Message): void {
  if (msg.type === 'error') {
    root.replaceChildren(cell('message', msg.message));
    return;
  }
  if (msg.type === 'changedFiles') {
    const el = root.querySelector<HTMLElement>('.files');
    if (el && msg.hash === commits[selected]?.hash) renderFiles(el, msg.hash, msg.files);
    return;
  }
  if (msg.type === 'details') {
    const pane = root.querySelector<HTMLElement>('.info');
    // Ignore late replies for a commit that is no longer selected.
    if (pane && msg.details.hash === commits[selected]?.hash) renderDetails(pane, msg.details);
    return;
  }
  commits = msg.commits;
  selected = -1;
  const list = document.createElement('div');
  list.className = 'commits';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commits');
  for (const [i, c] of commits.entries()) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = c.hash;
    row.setAttribute('role', 'option');
    row.append(
      cell('subject', c.subject), cell('author', c.authorName),
      cell('date', relativeDate(c.authorDate)), cell('hash', c.hash.slice(0, 8)),
    );
    row.addEventListener('click', () => select(list, i));
    list.append(row);
  }
  list.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    select(list, selected < 0 ? 0 : selected + step);
  });
  const pane = document.createElement('div');
  pane.className = 'details';
  const info = document.createElement('div');
  info.className = 'info';
  const files = document.createElement('div');
  files.className = 'files';
  pane.append(info, files);
  root.replaceChildren(list, pane);
}

const app = document.getElementById('app');
if (app) {
  window.addEventListener('message', (e: MessageEvent<Message>) => render(app, e.data));
  post({ type: 'loadCommits', skip: 0, limit: 1000 });
}
