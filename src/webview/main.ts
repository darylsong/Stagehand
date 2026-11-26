import type { Commit } from '../core/git';

export type Message = { type: 'commits'; skip: number; commits: Commit[] } | { type: 'error'; message: string };

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

export function render(root: HTMLElement, msg: Message): void {
  if (msg.type === 'error') {
    root.replaceChildren(cell('message', msg.message));
    return;
  }
  const list = document.createElement('div');
  list.className = 'commits';
  for (const c of msg.commits) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = c.hash;
    row.append(
      cell('subject', c.subject), cell('author', c.authorName),
      cell('date', relativeDate(c.authorDate)), cell('hash', c.hash.slice(0, 8)),
    );
    list.append(row);
  }
  root.replaceChildren(list);
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const app = document.getElementById('app');
if (app) {
  window.addEventListener('message', (e: MessageEvent<Message>) => render(app, e.data));
  // Standalone (browser/Playwright) there is no VS Code API; tests post messages directly.
  if (typeof acquireVsCodeApi === 'function') acquireVsCodeApi().postMessage({ type: 'loadCommits', skip: 0, limit: 1000 });
}
