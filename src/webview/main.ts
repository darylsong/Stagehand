import type { ChangedFile, Commit, CommitDetails, ErrorKind } from '../core/git';

export type Message =
  | { type: 'commits'; skip: number; commits: Commit[] }
  | { type: 'details'; details: CommitDetails }
  | { type: 'changedFiles'; hash: string; files: ChangedFile[] }
  | { type: 'error'; kind: ErrorKind; message: string };

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

export const ROW_HEIGHT = 22; // px; must match .row height in index.html
export const PAGE = 1000;
const OVERSCAN = 10; // rows rendered above and below the viewport
const PREFETCH = 200; // request the next page when the viewport is this many rows from the end

let commits: Commit[] = [];
let selected = -1;
let loading = true; // the first page is requested on load
let done = false; // a short page came back: no more commits

function loadMore(): void {
  loading = true;
  post({ type: 'loadCommits', skip: commits.length, limit: PAGE });
}

/** Renders only the rows in (and just around) the viewport; requests the next page near the end. */
function renderRows(list: HTMLElement): void {
  const rows = list.querySelector<HTMLElement>('.rows')!;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(commits.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) + OVERSCAN);
  const els: HTMLElement[] = [];
  for (let i = first; i < last; i++) {
    const c = commits[i]!;
    const row = document.createElement('div');
    row.className = i === selected ? 'row selected' : 'row';
    row.dataset.index = String(i);
    row.style.top = `${i * ROW_HEIGHT}px`;
    row.title = c.hash;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === selected));
    row.append(
      cell('subject', c.subject), cell('author', c.authorName),
      cell('date', relativeDate(c.authorDate)), cell('hash', c.hash.slice(0, 8)),
    );
    els.push(row);
  }
  rows.replaceChildren(...els);
  if (!loading && !done && last >= commits.length - PREFETCH) loadMore();
}

function select(list: HTMLElement, i: number): void {
  if (i < 0 || i >= commits.length || i === selected) return;
  selected = i;
  // Keep the selected row in view (the virtual-list version of scrollIntoView({block:'nearest'})).
  const top = i * ROW_HEIGHT;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  renderRows(list);
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
    // The text comes from src/core: a plain state message, or git's error text for kind 'git'.
    root.replaceChildren(cell(`message state-${msg.kind}`, msg.message));
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
  loading = false;
  done = msg.commits.length < PAGE;
  const existing = root.querySelector<HTMLElement>('.commits');
  if (msg.skip > 0) {
    // Next page: append if it continues the list we have; drop anything else (e.g. a page for an old list).
    if (!existing || msg.skip !== commits.length) return;
    commits = commits.concat(msg.commits);
    existing.querySelector<HTMLElement>('.spacer')!.style.height = `${commits.length * ROW_HEIGHT}px`;
    renderRows(existing);
    return;
  }
  commits = msg.commits;
  selected = -1;
  const list = document.createElement('div');
  list.className = 'commits';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commits');
  // ponytail: one tall spacer gives the scrollbar its full height; fine up to Chromium's ~33M px max (~1.5M rows).
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  spacer.style.height = `${commits.length * ROW_HEIGHT}px`;
  const rows = document.createElement('div');
  rows.className = 'rows';
  list.append(spacer, rows);
  list.addEventListener('scroll', () => renderRows(list));
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    if (row) select(list, Number(row.dataset.index));
  });
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
  renderRows(list);
}

const app = document.getElementById('app');
if (app) {
  window.addEventListener('message', (e: MessageEvent<Message>) => render(app, e.data));
  window.addEventListener('resize', () => {
    const list = app.querySelector<HTMLElement>('.commits');
    if (list) renderRows(list);
  });
  post({ type: 'loadCommits', skip: 0, limit: PAGE });
}
