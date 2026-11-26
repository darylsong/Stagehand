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
