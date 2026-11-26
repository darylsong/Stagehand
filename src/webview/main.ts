import type { ChangedFile, Commit, CommitDetails, ErrorKind } from '../core/git';
import { fileTree, type TreeNode } from '../core/fileTree';
import { graph, type GraphRow, type Lanes } from '../core/graph';

export type Message =
  | { type: 'commits'; skip: number; limit?: number; commits: Commit[] }
  | { type: 'refresh' }
  | { type: 'details'; details: CommitDetails }
  | { type: 'branches'; hash: string; branches: string[] }
  | { type: 'changedFiles'; hash: string | string[]; files: ChangedFile[]; gap?: number; error?: string }
  | { type: 'error'; kind: ErrorKind; message: string };

/** Splitter positions in px, kept in the webview state (VS Code restores it when the view reloads). */
interface Layout { paneWidth?: number; filesHeight?: number }
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState?(): Layout | undefined; setState?(s: Layout): void };
// Standalone (browser/Playwright) there is no VS Code API; tests post messages directly.
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const post = (msg: unknown) => vscode?.postMessage(msg);

const DAY = 86400000;
const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY; // local calendar day

/** Rider-style absolute date: "Today 2:21 PM", "Yesterday 4:54 PM", else the locale's short date and time. */
export function formatDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = dayNumber(now) - dayNumber(d);
  if (days === 0 || days === 1) {
    const word = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-days, 'day');
    return `${word[0]!.toLocaleUpperCase()}${word.slice(1)} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function cell(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

type RefKind = 'head' | 'local' | 'remote' | 'tag';

/** git's full-name decorations → kinds + short names. `HEAD -> refs/heads/x` gives HEAD and x; remotes' `HEAD` pointers are dropped. */
export function parseRefs(refs: string[]): { kind: RefKind; name: string }[] {
  return refs.flatMap((r): { kind: RefKind; name: string }[] => {
    if (r === 'HEAD') return [{ kind: 'head', name: 'HEAD' }];
    if (r.startsWith('HEAD -> ')) return [{ kind: 'head', name: 'HEAD' }, ...parseRefs([r.slice('HEAD -> '.length)])];
    if (r.startsWith('tag: ')) return [{ kind: 'tag', name: r.slice('tag: '.length).replace(/^refs\/tags\//, '') }];
    if (r.startsWith('refs/remotes/')) return r.endsWith('/HEAD') ? [] : [{ kind: 'remote', name: r.slice('refs/remotes/'.length) }];
    return [{ kind: 'local', name: r.replace(/^refs\/heads\//, '') }];
  });
}

const SVG = 'http://www.w3.org/2000/svg';
function refIcon(kind: RefKind): Element {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `ref ref-${kind}`);
  svg.setAttribute('viewBox', '0 0 12 12');
  const shape = document.createElementNS(SVG, kind === 'head' ? 'circle' : 'path');
  if (kind === 'head') for (const [k, v] of [['cx', '6'], ['cy', '6'], ['r', '4']]) shape.setAttribute(k!, v!);
  else shape.setAttribute('d', 'M1.5 2.5h5.5l3.5 3.5-3.5 3.5h-5.5z'); // a luggage-tag shape
  svg.append(shape);
  return svg;
}

/** Labels: one icon per ref, then the first non-HEAD name (truncated from the left); every name in the tooltip. */
function labels(refs: string[]): HTMLElement {
  const parsed = parseRefs(refs);
  const el = cell('refs', '');
  if (!parsed.length) return el;
  el.title = parsed.map((r) => r.name).join(', ');
  const name = cell('ref-name', '');
  name.append(cell('', (parsed.find((r) => r.kind !== 'head') ?? parsed[0]!).name)); // inner span: plain LTR text inside the RTL box
  el.append(cell('ref-icons', ''), name);
  el.firstElementChild!.append(...parsed.map((r) => refIcon(r.kind)));
  return el;
}

/** Line colours, by lane colour index; mid-tones that read on light and dark backgrounds. */
export const PALETTE = ['#4c9be8', '#e8a33d', '#4fb36b', '#e05d5d', '#a77de0', '#2fb5b5', '#d96fae', '#a6a63f'];
const LANE = 12; // px per graph lane

/** The row's graph cell: its lines, then the node on top (a ring for HEAD). */
function graphCell(g: GraphRow, isHead: boolean): Element {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'graph');
  svg.setAttribute('width', String(g.width * LANE));
  svg.setAttribute('height', String(ROW_HEIGHT));
  const x = (col: number) => col * LANE + LANE / 2;
  for (const l of g.lines) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', `M${x(l.x1)} ${l.y1 * ROW_HEIGHT}L${x(l.x2)} ${l.y2 * ROW_HEIGHT}`);
    path.setAttribute('stroke', PALETTE[l.color % PALETTE.length]!);
    svg.append(path);
  }
  const node = document.createElementNS(SVG, 'circle');
  node.setAttribute('class', isHead ? 'node node-head' : 'node');
  for (const [k, v] of [['cx', x(g.col)], ['cy', ROW_HEIGHT / 2], ['r', isHead ? 4 : 3.5]] as const) node.setAttribute(k, String(v));
  const color = PALETTE[g.color % PALETTE.length]!;
  node.setAttribute(isHead ? 'stroke' : 'fill', color);
  svg.append(node);
  return svg;
}

export const ROW_HEIGHT = 22; // px; must match .row height in index.html
export const PAGE = 1000;
const OVERSCAN = 10; // rows rendered above and below the viewport
const PREFETCH = 200; // request the next page when the viewport is this many rows from the end

let commits: Commit[] = [];
let graphRows: GraphRow[] = []; // graph(commits), row for row
let lanes: Lanes | undefined; // the graph's state after the last loaded commit
let selected = new Set<number>(); // indices into commits
let anchor = -1; // where a Shift range starts
let lead = -1; // the row Up/Down move from
let filesKey = ''; // the changedFiles request whose reply we're waiting for
let branches: { hash: string; names: string[] } | undefined; // the latest branchesContaining reply for the selected commit
let showBranches = false; // the "In N branches" list is expanded
let loading = true; // the first page is requested on load
let done = false; // a short page came back: no more commits

/** Reloads every loaded commit (at least a page); the skip-0 reply keeps the selection. */
function refresh(): void {
  loading = true;
  // ponytail: reloads all loaded rows in one request; fine for tens of thousands, page it if that gets slow.
  post({ type: 'loadCommits', skip: 0, limit: Math.max(PAGE, commits.length) });
}

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
    const isHead = c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '));
    row.className = `row${selected.has(i) ? ' selected' : ''}${isHead ? ' head' : ''}${c.parents.length > 1 ? ' merge' : ''}`;
    row.dataset.index = String(i);
    row.style.top = `${i * ROW_HEIGHT}px`;
    row.title = c.hash;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected.has(i)));
    const title = cell('title', '');
    title.append(cell('subject', c.subject), labels(c.refs));
    const date = cell('date', formatDate(c.authorDate));
    date.title = new Date(c.authorDate).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
    row.append(graphCell(graphRows[i]!, isHead), title, cell('author', c.authorName), date, cell('hash', c.hash.slice(0, 8)));
    els.push(row);
  }
  rows.replaceChildren(...els);
  if (!loading && !done && last >= commits.length - PREFETCH) loadMore();
}

const range = (a: number, b: number) => Array.from({ length: Math.abs(a - b) + 1 }, (_, k) => Math.min(a, b) + k);

/** Plain: select only i. toggle (Cmd/Ctrl): add/remove i. extend (Shift): anchor..i. */
function select(list: HTMLElement, i: number, mode: 'plain' | 'toggle' | 'extend' = 'plain'): void {
  if (i < 0 || i >= commits.length) return;
  if (mode === 'plain' && selected.size === 1 && selected.has(i)) return;
  if (mode === 'extend' && anchor >= 0) selected = new Set(range(anchor, i));
  else if (mode === 'toggle') {
    if (!selected.delete(i)) selected.add(i);
    anchor = i;
  } else {
    selected = new Set([i]);
    anchor = i;
  }
  lead = i;
  // Keep the selected row in view (the virtual-list version of scrollIntoView({block:'nearest'})).
  const top = i * ROW_HEIGHT;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  renderRows(list);
  showSelection();
}

/** Points the details pane at the selection: details + files for one, count + combined files for several. */
function showSelection(): void {
  const info = document.querySelector<HTMLElement>('.info')!;
  const files = document.querySelector<HTMLElement>('.files')!;
  const hashes = [...selected].sort((a, b) => a - b).map((k) => commits[k]!.hash);
  filesKey = JSON.stringify(hashes.length === 1 ? hashes[0] : hashes);
  if (hashes.length === 1) {
    post({ type: 'commitDetails', hash: hashes[0] });
    post({ type: 'changedFiles', hash: hashes[0] });
    post({ type: 'branchesContaining', hash: hashes[0] });
    return;
  }
  info.replaceChildren(...(hashes.length ? [cell('selection-count', `${hashes.length} commits selected`)] : []));
  files.replaceChildren();
  if (hashes.length) post({ type: 'changedFiles', hash: hashes });
}

/** The row context menu: Checkout, only when exactly one commit is selected. */
function showMenu(x: number, y: number, hash: string): void {
  hideMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = 'Checkout';
  item.addEventListener('click', () => {
    hideMenu();
    post({ type: 'checkout', hash });
  });
  menu.append(item);
  document.body.append(menu);
  item.focus();
}
const hideMenu = () => document.querySelector('.menu')?.remove();

const selectedHash = () => (selected.size === 1 ? commits[[...selected][0]!]?.hash : undefined);

function field(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'field';
  el.append(cell('label', label), cell(`value ${label.toLowerCase()}-value`, value));
  return el;
}

/** The banner above a combined list: the different-branches error, or the skipped-commits warning. */
function banner(gap = 0, error?: string): HTMLElement[] {
  if (error) return [cell('banner banner-error', error)];
  if (gap) return [cell('banner banner-gap', `Selection isn't contiguous: changes from ${gap} commits in between are included.`)];
  return [];
}

function renderFiles(el: HTMLElement, hash: string | string[], files: ChangedFile[], gap?: number, error?: string): void {
  el.replaceChildren(...banner(gap, error), ...treeRows(fileTree(files), hash, 0));
}

/** Tree rows, indented by depth: a folder is a header (twisty, name, file count) above its children; all start expanded. */
function treeRows(nodes: TreeNode[], hash: string | string[], depth: number): HTMLElement[] {
  return nodes.map((n) => {
    if (n.kind === 'file') return fileRow(n.file, n.name, hash, depth);
    const group = document.createElement('div');
    group.className = 'folder-group';
    const head = document.createElement('div');
    head.className = 'folder';
    head.tabIndex = 0;
    head.title = n.path;
    head.style.paddingLeft = `${depth * 16}px`;
    head.setAttribute('aria-expanded', 'true');
    head.append(cell('twisty', '▾'), cell('folder-name', n.name), cell('count', String(n.count)));
    const toggle = () => head.setAttribute('aria-expanded', String(!group.classList.toggle('collapsed')));
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') toggle();
    });
    const children = document.createElement('div');
    children.className = 'folder-children';
    children.append(...treeRows(n.children, hash, depth + 1));
    group.append(head, children);
    return group;
  });
}

function fileRow(f: ChangedFile, name: string, hash: string | string[], depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file';
  row.tabIndex = 0;
  row.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  row.style.paddingLeft = `${depth * 16 + 14}px`; // + twisty width: names line up with folder names
  row.append(cell(`status status-${f.status}`, f.status), cell('path', name));
  if (f.binary) {
    row.append(cell('binary', 'Binary file changed'));
    return row;
  }
  // Combined lists: the file carries base/target and the extension diffs those; hash is then just the newest commit.
  const open = (preview: boolean) => post({ type: 'openDiff', hash: typeof hash === 'string' ? hash : hash[0], file: f, preview });
  row.addEventListener('click', () => open(true));
  row.addEventListener('dblclick', () => open(false));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open(true);
  });
  return row;
}

/** "In N branches" plus a Hide/Show toggle for the names; empty until the reply for the shown commit arrives. */
function renderBranches(el: HTMLElement, hash: string): void {
  if (branches?.hash !== hash) {
    el.replaceChildren();
    return;
  }
  const n = branches.names.length;
  el.replaceChildren(cell('branch-count', `In ${n} ${n === 1 ? 'branch' : 'branches'}`));
  if (!n) return;
  const toggle = document.createElement('button');
  toggle.className = 'branches-toggle';
  toggle.textContent = showBranches ? 'Hide' : 'Show';
  toggle.addEventListener('click', () => {
    showBranches = !showBranches;
    renderBranches(el, hash);
  });
  el.append(toggle);
  if (showBranches) el.append(cell('branch-list', branches.names.join(', ')));
}

function renderDetails(pane: HTMLElement, d: CommitDetails): void {
  const cut = d.message.indexOf('\n\n');
  const body = document.createElement('pre');
  body.className = 'message-body';
  body.textContent = cut < 0 ? '' : d.message.slice(cut + 2);
  const date = new Date(d.authorDate);
  const when = `${date.toLocaleDateString()} at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  // Labels: the same icons as the row, each with its full name (the pane has room for all of them).
  const refs = cell('detail-refs', '');
  refs.append(...parseRefs(commits[[...selected][0]!]?.refs ?? []).map((r) => {
    const label = cell('detail-ref', '');
    label.append(refIcon(r.kind), cell('ref-name', r.name));
    return label;
  }));
  const inBranches = document.createElement('div');
  inBranches.className = 'in-branches';
  renderBranches(inBranches, d.hash);
  const hash = field('Hash', d.hash);
  const copy = document.createElement('button');
  copy.className = 'copy';
  copy.textContent = 'Copy';
  copy.title = 'Copy full hash';
  copy.addEventListener('click', () => post({ type: 'copy', text: d.hash }));
  hash.append(copy);
  pane.replaceChildren(
    cell('message-subject', cut < 0 ? d.message : d.message.slice(0, cut)),
    body,
    cell('commit-line', `${d.hash.slice(0, 8)} ${d.authorName} <${d.authorEmail}> on ${when}`),
    refs,
    inBranches,
    field('Parents', d.parents.join(' ') || '(none)'),
    hash,
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
    if (el && JSON.stringify(msg.hash) === filesKey) renderFiles(el, msg.hash, msg.files, msg.gap, msg.error);
    return;
  }
  if (msg.type === 'details') {
    const pane = root.querySelector<HTMLElement>('.info');
    // Ignore late replies for a commit that is no longer selected.
    if (pane && msg.details.hash === selectedHash()) renderDetails(pane, msg.details);
    return;
  }
  if (msg.type === 'branches') {
    // Ignore late replies for a commit that is no longer selected.
    if (msg.hash !== selectedHash()) return;
    branches = { hash: msg.hash, names: msg.branches };
    const el = root.querySelector<HTMLElement>('.in-branches');
    if (el) renderBranches(el, msg.hash);
    return;
  }
  if (msg.type === 'refresh') {
    refresh();
    return;
  }
  loading = false;
  done = msg.commits.length < (msg.limit ?? PAGE);
  const existing = root.querySelector<HTMLElement>('.commits');
  if (msg.skip > 0) {
    // Next page: append if it continues the list we have; drop anything else (e.g. a page for an old list).
    if (!existing || msg.skip !== commits.length) return;
    commits = commits.concat(msg.commits);
    const g = graph(msg.commits, lanes);
    graphRows = graphRows.concat(g.rows);
    lanes = g.state;
    existing.querySelector<HTMLElement>('.spacer')!.style.height = `${commits.length * ROW_HEIGHT}px`;
    renderRows(existing);
    return;
  }
  // A refresh (or any first page): keep the selected commits that are still in the list, by hash.
  const before = [...selected].map((i) => commits[i]!.hash);
  const hashAt = (i: number) => commits[i]?.hash ?? '';
  const [anchorHash, leadHash] = [hashAt(anchor), hashAt(lead)];
  commits = msg.commits;
  ({ rows: graphRows, state: lanes } = graph(commits));
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  selected = new Set(before.flatMap((h) => (index.has(h) ? [index.get(h)!] : [])));
  anchor = index.get(anchorHash) ?? -1;
  lead = index.get(leadHash) ?? -1;
  const list = existing ?? build(root);
  list.querySelector<HTMLElement>('.spacer')!.style.height = `${commits.length * ROW_HEIGHT}px`;
  renderRows(list);
  // Same commits still selected: the pane already shows them. Otherwise point it at what's left (or clear it).
  if (selected.size !== before.length || !existing) showSelection();
}

/** Builds the list, the refresh button and the details pane. */
function build(root: HTMLElement): HTMLElement {
  const list = document.createElement('div');
  list.className = 'commits';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commits');
  // ponytail: one tall spacer gives the scrollbar its full height; fine up to Chromium's ~33M px max (~1.5M rows).
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const rows = document.createElement('div');
  rows.className = 'rows';
  list.append(spacer, rows);
  list.addEventListener('scroll', () => renderRows(list));
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    if (row) select(list, Number(row.dataset.index), e.shiftKey ? 'extend' : e.ctrlKey || e.metaKey ? 'toggle' : 'plain');
  });
  list.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    if (!row) return;
    e.preventDefault();
    const i = Number(row.dataset.index);
    if (!selected.has(i)) select(list, i);
    hideMenu();
    if (selected.size === 1) showMenu(e.clientX, e.clientY, commits[i]!.hash);
  });
  list.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    select(list, lead < 0 ? 0 : lead + step, e.shiftKey && lead >= 0 ? 'extend' : 'plain');
  });
  const pane = document.createElement('div');
  pane.className = 'details';
  const info = document.createElement('div');
  info.className = 'info';
  const files = document.createElement('div');
  files.className = 'files';
  const layout: Layout = vscode?.getState?.() ?? {};
  if (layout.paneWidth) pane.style.width = `${layout.paneWidth}px`;
  if (layout.filesHeight) files.style.height = `${layout.filesHeight}px`;
  const save = () => vscode?.setState?.(layout);
  // Files on top, details below; CSS max-width/max-height keep a saved size inside a smaller window.
  pane.append(files, splitter('horizontal', (e) => {
    layout.filesHeight = Math.max(40, Math.round(e.clientY - pane.getBoundingClientRect().top));
    files.style.height = `${layout.filesHeight}px`;
  }, save), info);
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const button = document.createElement('button');
  button.className = 'refresh';
  button.textContent = '↻ Refresh';
  button.title = 'Reload the history';
  button.addEventListener('click', refresh);
  toolbar.append(button);
  const main = document.createElement('div');
  main.className = 'main';
  main.append(toolbar, list);
  root.replaceChildren(main, splitter('vertical', (e) => {
    layout.paneWidth = Math.max(150, Math.round(root.getBoundingClientRect().right - e.clientX));
    pane.style.width = `${layout.paneWidth}px`;
  }, save), pane);
  return list;
}

/** A draggable bar: calls move while the pointer drags it, done when released. */
function splitter(orientation: 'vertical' | 'horizontal', move: (e: PointerEvent) => void, done: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = `splitter splitter-${orientation}`;
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', orientation);
  // ponytail: mouse only; add arrow-key resizing if keyboard users need it.
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => {
      el.removeEventListener('pointermove', move);
      done();
    }, { once: true });
  });
  return el;
}

const app = document.getElementById('app');
if (app) {
  window.addEventListener('message', (e: MessageEvent<Message>) => render(app, e.data));
  window.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('.menu')) hideMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('resize', () => {
    const list = app.querySelector<HTMLElement>('.commits');
    if (list) renderRows(list);
  });
  post({ type: 'loadCommits', skip: 0, limit: PAGE });
}
