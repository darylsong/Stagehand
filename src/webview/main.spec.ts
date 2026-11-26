import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ChangedFile, Commit } from '../core/git';

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

test('click selects a row, Down moves the selection, and the pane shows the posted details', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 200 });
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const posted = () => p.evaluate(() => (window as unknown as { posted: unknown[] }).posted.slice(1));
  const rows = p.locator('.row');

  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await p.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(rows.nth(0)).not.toHaveClass(/selected/);
  await expect(p.locator('.row.selected')).toHaveCount(1);
  expect(await posted()).toEqual([
    { type: 'commitDetails', hash: commits[0]!.hash },
    { type: 'changedFiles', hash: commits[0]!.hash },
    { type: 'commitDetails', hash: commits[1]!.hash },
    { type: 'changedFiles', hash: commits[1]!.hash },
  ]);

  // A late reply for the previously selected commit is ignored.
  const details = (c: Commit, message: string) => ({
    hash: c.hash, parents: [commits[2]!.hash, commits[3]!.hash], subject: c.subject,
    authorName: c.authorName, authorEmail: 'alice@example.com', authorDate: '2024-03-05T14:07:00Z', message,
  });
  await p.evaluate((d) => window.postMessage({ type: 'details', details: d }, '*'), details(commits[0]!, 'stale'));
  await p.evaluate((d) => window.postMessage({ type: 'details', details: d }, '*'),
    details(commits[1]!, 'Commit number 1\n\nA body that spans\ntwo lines.'));
  const pane = p.locator('.details');
  await expect(pane.locator('.full-message')).toHaveText('Commit number 1\n\nA body that spans\ntwo lines.');
  await expect(pane.locator('.author-value')).toHaveText('Alice <alice@example.com>');
  // Format in the browser, not in Node: their default locales can differ (they do on a non-en-US machine).
  const date = await p.evaluate(() => new Date('2024-03-05T14:07:00Z').toLocaleString());
  await expect(pane.locator('.date-value')).toHaveText(date);
  await expect(pane.locator('.hash-value')).toHaveText(commits[1]!.hash);
  await expect(pane.locator('.parents-value')).toHaveText(`${commits[2]!.hash} ${commits[3]!.hash}`);
  await p.screenshot({ path: 'test-results/screenshots/005-details.png' });

  await pane.locator('button.copy').click();
  expect((await posted()).at(-1)).toEqual({ type: 'copy', text: commits[1]!.hash });

  // Moving past the bottom of the viewport keeps the selection visible; Up moves back.
  await rows.nth(1).click();
  for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowDown');
  await expect(rows.nth(21)).toHaveClass(/selected/);
  await expect(rows.nth(21)).toBeInViewport({ ratio: 1 });
  await p.keyboard.press('ArrowUp');
  await expect(rows.nth(20)).toHaveClass(/selected/);
  await p.screenshot({ path: 'test-results/screenshots/005-scrolled.png' });
});

test('the selected commit lists its changed files with status letters, rename arrow and binary flag', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 300 });
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  await p.locator('.row').nth(2).click();
  const posted = await p.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
  expect(posted).toContainEqual({ type: 'changedFiles', hash: commits[2]!.hash });

  const files: ChangedFile[] = [
    { status: 'A', path: 'src/added.ts', binary: false },
    { status: 'M', path: 'README.md', binary: false },
    { status: 'D', path: 'old/removed.txt', binary: false },
    { status: 'R', oldPath: 'src/before.ts', path: 'src/after.ts', binary: false },
    { status: 'A', path: 'assets/logo.png', binary: true },
  ];
  // A reply for another commit is ignored.
  await p.evaluate((f) => window.postMessage({ type: 'changedFiles', hash: 'deadbeef', files: f }, '*'), files.slice(0, 1));
  await p.evaluate(([h, f]) => window.postMessage({ type: 'changedFiles', hash: h, files: f }, '*'), [commits[2]!.hash, files] as const);
  const rows = p.locator('.details .file');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('.status')).toHaveText(['A', 'M', 'D', 'R', 'A']);
  await expect(rows.locator('.path')).toHaveText(['src/added.ts', 'README.md', 'old/removed.txt', 'src/before.ts → src/after.ts', 'assets/logo.png']);
  await expect(rows.nth(4).locator('.binary')).toHaveText('Binary file changed');
  await expect(p.locator('.details .binary')).toHaveCount(1);
  await p.screenshot({ path: 'test-results/screenshots/006-files.png' });
});

test('click opens a preview diff, double click pins it, Enter opens the focused file, binary opens nothing', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 300 });
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  await p.locator('.row').nth(1).click();
  const hash = commits[1]!.hash;
  const files: ChangedFile[] = [
    { status: 'M', path: 'README.md', binary: false },
    { status: 'R', oldPath: 'src/before.ts', path: 'src/after.ts', binary: false },
    { status: 'A', path: 'assets/logo.png', binary: true },
  ];
  await p.evaluate(([h, f]) => window.postMessage({ type: 'changedFiles', hash: h, files: f }, '*'), [hash, files] as const);
  const rows = p.locator('.details .file');
  await expect(rows).toHaveCount(3);
  const clear = () => p.evaluate(() => { (window as unknown as { posted: unknown[] }).posted = []; });
  const posted = () => p.evaluate(() => (window as unknown as { posted: unknown[] }).posted);

  await clear();
  await rows.nth(0).click();
  expect(await posted()).toEqual([{ type: 'openDiff', hash, file: files[0], preview: true }]);

  await clear();
  await rows.nth(1).dblclick();
  expect((await posted()).at(-1)).toEqual({ type: 'openDiff', hash, file: files[1], preview: false });

  await clear();
  await rows.nth(1).focus();
  await p.keyboard.press('Enter');
  expect(await posted()).toEqual([{ type: 'openDiff', hash, file: files[1], preview: true }]);

  await clear();
  await rows.nth(2).click();
  await rows.nth(2).dblclick();
  await rows.nth(2).focus();
  await p.keyboard.press('Enter');
  expect(await posted()).toEqual([]);
  await expect(rows.nth(2).locator('.binary')).toHaveText('Binary file changed');
  await p.screenshot({ path: 'test-results/screenshots/007-files.png' });
});

const states = [
  { kind: 'no-folder', message: 'No folder open' },
  { kind: 'not-repo', message: 'Not a git repository' },
  { kind: 'no-commits', message: 'Repository has no commits' },
  { kind: 'git-not-found', message: 'git not found on PATH' },
  { kind: 'git', message: "fatal: unable to read tree 1234abcd\nfatal: bad object HEAD" },
];
for (const state of states) {
  test(`the ${state.kind} state replaces the list with its message`, async ({ page: p }) => {
    await p.goto(page);
    await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
    await expect(p.locator('.row')).toHaveCount(25);
    await p.evaluate((m) => window.postMessage({ type: 'error', ...m }, '*'), state);
    await expect(p.locator('.row')).toHaveCount(0);
    await expect(p.locator('#app')).toHaveText(state.message, { useInnerText: true });
    await expect(p.locator(`.message.state-${state.kind}`)).toBeVisible();
    await p.screenshot({ path: `test-results/screenshots/002-${state.kind}.png` });
  });
}
