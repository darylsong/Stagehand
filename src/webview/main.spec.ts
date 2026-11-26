import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Commit } from '../core/git';

const page = pathToFileURL(resolve('out/webview/index.html')).href;

const commits: Commit[] = Array.from({ length: 25 }, (_, i) => ({
  hash: `${String(i).padStart(2, '0')}${'abcdef0123456789'.repeat(3)}abcdef01`,
  parents: [],
  subject: i === 0 ? 'Fix parser | handle pipes' : `Commit number ${i}`,
  authorName: i % 2 ? 'Alice' : 'Bob',
  authorEmail: 'a@example.com',
  authorDate: new Date(Date.now() - (i + 1) * 3 * 3600_000).toISOString(),
  refs: [],
}));

test('renders a page of commits', async ({ page: p }) => {
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const rows = p.locator('.row');
  await expect(rows).toHaveCount(25);
  const first = rows.first();
  await expect(first.locator('.subject')).toHaveText('Fix parser | handle pipes');
  await expect(first.locator('.author')).toHaveText('Bob');
  await expect(first.locator('.date')).toHaveText('3 hours ago');
  await expect(first.locator('.hash')).toHaveText('00abcdef');
  // Saved for the agent to Read and inspect visually.
  await p.screenshot({ path: 'test-results/screenshots/001-list.png' });
});

test('inside VS Code it asks for the first page once on load', async ({ page: p }) => {
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  await expect(p.locator('.row')).toHaveCount(25);
  const posted = await p.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
  expect(posted).toEqual([{ type: 'loadCommits', skip: 0, limit: 1000 }]);
  await p.screenshot({ path: 'test-results/screenshots/013-list.png' });
});

test('the hash column has a fixed width and the standalone page has neutral colours', async ({ page: p }) => {
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const hash = await p.locator('.hash').first().evaluate((e) => {
    const s = getComputedStyle(e);
    return { shrink: s.flexShrink, grow: s.flexGrow, width: s.width };
  });
  expect(hash.shrink).toBe('0');
  expect(hash.grow).toBe('0');
  expect(parseFloat(hash.width)).toBeGreaterThan(0);
  const body = await p.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(body).toEqual({ color: 'rgb(51, 51, 51)', background: 'rgb(255, 255, 255)' });
});
