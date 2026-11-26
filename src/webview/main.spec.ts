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
  await expect(first.locator('.date')).toHaveText(/^(Today|Yesterday) \d/); // 3 hours ago
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

test('rows show branch and tag labels as icons + the first name, and mark the HEAD commit, attached or detached', async ({ page: p }) => {
  const labelled = commits.slice(0, 5).map((c, i) => ({
    ...c,
    refs: [
      ['HEAD -> refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/origin/HEAD'],
      ['refs/heads/feature', 'tag: refs/tags/v1'], [], ['HEAD', 'tag: refs/tags/v0.9'], ['refs/remotes/origin/chore/x'],
    ][i]!,
  }));
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), labelled);
  const rows = p.locator('.row');
  const kinds = (i: number) => rows.nth(i).locator('.ref').evaluateAll((els) => els.map((e) => e.getAttribute('class')));
  expect(await kinds(0)).toEqual(['ref ref-head', 'ref ref-local', 'ref ref-remote']); // origin/HEAD dropped
  await expect(rows.nth(0).locator('.ref-name')).toHaveText('main');
  await expect(rows.nth(0).locator('.refs')).toHaveAttribute('title', 'HEAD, main, origin/main');
  expect(await kinds(1)).toEqual(['ref ref-local', 'ref ref-tag']);
  await expect(rows.nth(1).locator('.ref-name')).toHaveText('feature');
  await expect(rows.nth(2).locator('.ref')).toHaveCount(0);
  // Detached: bare HEAD.
  expect(await kinds(3)).toEqual(['ref ref-head', 'ref ref-tag']);
  await expect(rows.nth(3).locator('.ref-name')).toHaveText('v0.9');
  await expect(rows.nth(4).locator('.ref-name')).toHaveText('origin/chore/x');
  await expect(p.locator('.row.head')).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/\bhead\b/);
  await expect(rows.nth(3)).toHaveClass(/\bhead\b/);
  // Each kind looks different.
  const look = (sel: string) => p.locator(sel).first().evaluate((e) => {
    const s = getComputedStyle(e.firstElementChild!);
    return [s.fill, s.stroke].join();
  });
  const looks = await Promise.all(['.ref-head', '.ref-local', '.ref-remote', '.ref-tag'].map(look));
  expect(new Set(looks).size).toBe(4);
  await p.screenshot({ path: 'test-results/screenshots/004-labels.png' });
});

test.describe('fixed clock, en-US, UTC', () => {
  test.use({ locale: 'en-US', timezoneId: 'UTC' });

  test('dates are Rider-style: Today/Yesterday + time, else short date + time; full timestamp in the tooltip', async ({ page: p }) => {
    await p.clock.setFixedTime(new Date('2026-11-26T15:00:00Z'));
    await p.goto(page);
    const dated = ['2026-11-26T14:21:00Z', '2026-11-25T16:54:00Z', '2026-11-24T18:20:00Z', '2025-01-02T09:05:00Z']
      .map((d, i) => ({ ...commits[i]!, authorDate: d }));
    await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), dated);
    const dates = p.locator('.date');
    await expect(dates.nth(0)).toHaveText(/^Today 2:21\sPM$/);
    await expect(dates.nth(1)).toHaveText(/^Yesterday 4:54\sPM$/);
    await expect(dates.nth(2)).toHaveText(/^11\/24\/26, 6:20\sPM$/);
    await expect(dates.nth(3)).toHaveText(/^1\/2\/25, 9:05\sAM$/);
    await expect(dates.nth(0)).toHaveAttribute('title', /November 26, 2026/);
  });
});

test('narrow widths: columns line up, labels never cover the subject, author hides then date', async ({ page: p }) => {
  const mixed = commits.slice(0, 6).map((c, i) => ({
    ...c,
    subject: i % 2 ? 'A rather long subject line that will need to be truncated somewhere' : c.subject,
    refs: i === 0 ? ['HEAD -> refs/heads/chore/sdk-airgile-bumps', 'refs/remotes/origin/chore/sdk-airgile-bumps']
      : i === 2 ? ['refs/remotes/origin/feature/identity-platform-auth'] : [],
    parents: i === 4 ? ['a', 'b'] : [],
  }));
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), mixed);
  const lefts = (sel: string) => p.locator(`.row ${sel}`).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  const visible = (sel: string) => p.locator(`.row ${sel}`).first().isVisible();
  for (const width of [1200, 800, 600, 420]) {
    await p.setViewportSize({ width, height: 300 });
    for (const sel of ['.author', '.date', '.hash']) {
      if (!(await visible(sel))) continue;
      expect(new Set(await lefts(sel)).size, `${sel} at ${width}px`).toBe(1);
    }
    // The subject keeps real space and the labels sit after it, not on top.
    const boxes = await p.locator('.row').evaluateAll((rows) => rows.map((r) => {
      const subject = r.querySelector('.subject')!.getBoundingClientRect();
      const refs = r.querySelector('.refs')!.getBoundingClientRect();
      const hash = r.querySelector('.hash')!.getBoundingClientRect();
      return { subject: subject.width, overlap: subject.right > refs.left + 0.5, hashRight: hash.right, rowRight: r.getBoundingClientRect().right };
    }));
    for (const b of boxes) {
      expect(b.subject).toBeGreaterThan(40);
      expect(b.overlap).toBe(false);
      expect(b.rowRight - b.hashRight).toBeGreaterThanOrEqual(12); // clear of an overlay scrollbar
    }
    await p.screenshot({ path: `test-results/screenshots/014-width-${width}.png` });
  }
  // The list is 60% of the page (the pane takes 40%).
  for (const [width, author, date] of [[1200, true, true], [900, false, true], [700, false, false]] as const) {
    await p.setViewportSize({ width, height: 300 });
    const listWidth = await p.locator('.commits').evaluate((e) => e.clientWidth);
    expect([await visible('.author'), await visible('.date')], `list ${listWidth}px`).toEqual([author, date]);
  }
  // Merge commits are dimmed.
  const color = (i: number) => p.locator('.row .subject').nth(i).evaluate((e) => getComputedStyle(e).color);
  expect(await color(4)).not.toBe(await color(2));
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
    { type: 'branchesContaining', hash: commits[0]!.hash },
    { type: 'commitDetails', hash: commits[1]!.hash },
    { type: 'changedFiles', hash: commits[1]!.hash },
    { type: 'branchesContaining', hash: commits[1]!.hash },
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
  await expect(pane.locator('.message-subject')).toHaveText('Commit number 1');
  await expect(pane.locator('.message-body')).toHaveText('A body that spans\ntwo lines.');
  await expect(pane.locator('.commit-line')).toContainText('Alice <alice@example.com> on ');
  await expect(pane.locator('.hash-value')).toHaveText(commits[1]!.hash);
  await expect(pane.locator('.parents-value')).toHaveText(`${commits[2]!.hash} ${commits[3]!.hash}`);
  await p.screenshot({ path: 'test-results/screenshots/005-details.png' });

  await pane.locator('button.copy').click();
  expect((await posted()).at(-1)).toEqual({ type: 'copy', text: commits[1]!.hash });

  // Moving past the bottom of the viewport keeps the selection visible; Up moves back.
  await rows.nth(1).click();
  for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowDown');
  // The list is virtual (rows above the viewport aren't in the DOM), so find rows by their commit index.
  const row = (i: number) => p.locator(`.row[data-index="${i}"]`);
  await expect(row(21)).toHaveClass(/selected/);
  await expect(row(21)).toBeInViewport({ ratio: 1 });
  await p.keyboard.press('ArrowUp');
  await expect(row(20)).toHaveClass(/selected/);
  await p.screenshot({ path: 'test-results/screenshots/005-scrolled.png' });
});

test.describe('details pane, en-US, UTC', () => {
  test.use({ locale: 'en-US', timezoneId: 'UTC' });

  test('Rider-style details: bold subject, body, hash/author/date line, labels, In N branches with Hide/Show, parents and Copy', async ({ page: p }) => {
    await p.setViewportSize({ width: 1000, height: 400 });
    await p.addInitScript(() => {
      const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
      w.posted = [];
      w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
    });
    await p.goto(page);
    const labelled = commits.map((c, i) => (i === 1 ? { ...c, refs: ['HEAD -> refs/heads/main', 'refs/remotes/origin/main', 'tag: refs/tags/v1.0'] } : c));
    await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), labelled);
    const posted = () => p.evaluate(() => (window as unknown as { posted: { type: string }[] }).posted);
    const send = (msg: unknown) => p.evaluate((m) => window.postMessage(m, '*'), msg);
    const rows = p.locator('.row');
    const pane = p.locator('.details .info');
    const c1 = commits[1]!;

    // Selecting a single commit asks for its branches automatically.
    await rows.nth(0).click();
    await rows.nth(1).click();
    expect((await posted()).filter((m) => m.type === 'branchesContaining'))
      .toEqual([{ type: 'branchesContaining', hash: commits[0]!.hash }, { type: 'branchesContaining', hash: c1.hash }]);
    await send({ type: 'details', details: {
      hash: c1.hash, parents: [commits[2]!.hash], subject: 'Commit number 1', authorName: 'Alice', authorEmail: 'alice@example.com',
      authorDate: '2024-03-05T14:07:00Z', message: 'Commit number 1\n\nBody line one\nline two',
    } });

    await expect(pane.locator('.message-subject')).toHaveText('Commit number 1');
    await expect(pane.locator('.message-subject')).toHaveCSS('font-weight', '700');
    await expect(pane.locator('.message-body')).toHaveText('Body line one\nline two');
    await expect(pane.locator('.commit-line')).toHaveText(/^01abcdef Alice <alice@example\.com> on 3\/5\/2024 at 2:07\sPM$/);

    // Labels: the row's icons, one per ref, each with its name.
    const refs = pane.locator('.detail-ref');
    await expect(refs.locator('.ref-name')).toHaveText(['HEAD', 'main', 'origin/main', 'v1.0']);
    await expect(refs.locator('svg')).toHaveClass(['ref ref-head', 'ref ref-local', 'ref ref-remote', 'ref ref-tag']);
    const fill = (sel: string) => p.locator(sel).first().evaluate((e) => getComputedStyle(e).fill);
    expect(await fill('.detail-ref .ref-remote path')).toBe(await fill('.row .ref-remote path'));

    // A reply for the older selection is dropped; the current one shows the count, collapsed.
    const branchesEl = pane.locator('.in-branches');
    await send({ type: 'branches', hash: commits[0]!.hash, branches: ['stale'] });
    await expect(branchesEl).toBeEmpty();
    await send({ type: 'branches', hash: c1.hash, branches: ['main', 'origin/main', 'feature'] });
    await expect(branchesEl.locator('.branch-count')).toHaveText('In 3 branches');
    await expect(branchesEl.locator('.branches-toggle')).toHaveText('Show');
    await expect(branchesEl.locator('.branch-list')).toHaveCount(0);
    await branchesEl.locator('.branches-toggle').click();
    await expect(branchesEl.locator('.branches-toggle')).toHaveText('Hide');
    await expect(branchesEl.locator('.branch-list')).toHaveText('main, origin/main, feature');

    // Parents and the full-hash Copy button are kept.
    await expect(pane.locator('.parents-value')).toHaveText(commits[2]!.hash);
    await expect(pane.locator('.hash-value')).toHaveText(c1.hash);
    await p.screenshot({ path: 'test-results/screenshots/015-details.png' });
    await pane.locator('button.copy').click();
    expect((await posted()).at(-1)).toEqual({ type: 'copy', text: c1.hash });
    await branchesEl.locator('.branches-toggle').click();
    await expect(branchesEl.locator('.branch-list')).toHaveCount(0);
    await expect(branchesEl.locator('.branches-toggle')).toHaveText('Show');

    // The branches reply may beat the details reply; it still shows once the details arrive.
    await rows.nth(2).click();
    await send({ type: 'branches', hash: commits[2]!.hash, branches: ['main'] });
    await send({ type: 'details', details: { ...commits[2]!, message: 'Commit number 2' } });
    await expect(pane.locator('.in-branches .branch-count')).toHaveText('In 1 branch');
    await expect(pane.locator('.message-body')).toHaveText('');
    await expect(pane.locator('.detail-ref')).toHaveCount(0);
  });
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
  // Tree order: folders (assets, old, src) first, then root files.
  await expect(rows.locator('.status')).toHaveText(['A', 'D', 'A', 'R', 'M']);
  await expect(rows.locator('.path')).toHaveText(['logo.png', 'removed.txt', 'added.ts', 'before.ts → after.ts', 'README.md']);
  await expect(rows.nth(3)).toHaveAttribute('title', 'src/before.ts → src/after.ts');
  await expect(rows.nth(0).locator('.binary')).toHaveText('Binary file changed');
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
  const all = p.locator('.details .file');
  await expect(all).toHaveCount(3);
  const rows = { nth: (i: number) => all.filter({ hasText: ['README.md', 'after.ts', 'logo.png'][i]! }) }; // files[i]'s row
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

test('Ctrl-click toggles, Shift-click selects a range, Shift+Down extends; the pane shows the count and the combined files', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 400 });
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const rows = p.locator('.row');
  const selectedIndices = () => p.locator('.row.selected').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.index)));
  const posted = () => p.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
  const clear = () => p.evaluate(() => { (window as unknown as { posted: unknown[] }).posted = []; });
  const h = (...i: number[]) => i.map((k) => commits[k]!.hash);

  await rows.nth(1).click();
  await rows.nth(3).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIndices()).toEqual([1, 3]);
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIndices()).toEqual([3]);
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIndices()).toEqual([1, 3]);

  // Shift-click: range from the anchor (the last clicked row, 1) to the clicked row, replacing the selection.
  await clear();
  await rows.nth(4).click({ modifiers: ['Shift'] });
  expect(await selectedIndices()).toEqual([1, 2, 3, 4]);
  expect(await posted()).toEqual([{ type: 'changedFiles', hash: h(1, 2, 3, 4) }]);
  await expect(p.locator('.details .info')).toHaveText('4 commits selected');

  await clear();
  await p.keyboard.press('Shift+ArrowDown');
  expect(await selectedIndices()).toEqual([1, 2, 3, 4, 5]);
  await expect(p.locator('.details .info')).toHaveText('5 commits selected');
  await p.keyboard.press('Shift+ArrowUp');
  await p.keyboard.press('Shift+ArrowUp');
  expect(await selectedIndices()).toEqual([1, 2, 3]);
  expect((await posted()).at(-1)).toEqual({ type: 'changedFiles', hash: h(1, 2, 3) });

  // The combined reply is shown; opening a file posts the file with its base/target range.
  const files: ChangedFile[] = [
    { status: 'M', path: 'README.md', binary: false, base: h(4)[0], target: h(1)[0] },
    { status: 'A', path: 'src/new.ts', binary: false, base: h(3)[0], target: h(2)[0] },
  ];
  await p.evaluate(([hs, f]) => window.postMessage({ type: 'changedFiles', hash: hs, files: f }, '*'), [h(1, 2, 3, 4), files] as const);
  await expect(p.locator('.details .file')).toHaveCount(0); // reply for an older selection is dropped
  await p.evaluate(([hs, f]) => window.postMessage({ type: 'changedFiles', hash: hs, files: f }, '*'), [h(1, 2, 3), files] as const);
  await expect(p.locator('.details .file .path')).toHaveText(['new.ts', 'README.md']);
  await p.screenshot({ path: 'test-results/screenshots/009-multi-select.png' });
  await clear();
  await p.locator('.details .file').filter({ hasText: 'README.md' }).click();
  expect(await posted()).toEqual([{ type: 'openDiff', hash: h(1)[0], file: files[0], preview: true }]);

  // A plain click goes back to one commit with its details.
  await clear();
  await rows.nth(2).click();
  expect(await selectedIndices()).toEqual([2]);
  expect(await posted()).toEqual([
    { type: 'commitDetails', hash: h(2)[0] }, { type: 'changedFiles', hash: h(2)[0] }, { type: 'branchesContaining', hash: h(2)[0] },
  ]);
});

test('combined results show the non-contiguous banner, the different-branches banner, and no banner for a gap of 0', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 400 });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const rows = p.locator('.row');
  await rows.nth(1).click();
  await rows.nth(4).click({ modifiers: ['ControlOrMeta'] });
  const hs = [commits[1]!.hash, commits[4]!.hash];
  const files: ChangedFile[] = [{ status: 'M', path: 'README.md', binary: false, base: commits[5]!.hash, target: hs[0] }];
  const reply = (extra: object) => p.evaluate((m) => window.postMessage(m, '*'), { type: 'changedFiles', hash: hs, files, ...extra });
  const banner = p.locator('.details .files .banner');

  await reply({ gap: 2 });
  await expect(banner).toHaveText("Selection isn't contiguous: changes from 2 commits in between are included.");
  await expect(p.locator('.details .file .path')).toHaveText(['README.md']);
  await p.screenshot({ path: 'test-results/screenshots/010-gap-banner.png' });

  await reply({ gap: 0 });
  await expect(p.locator('.details .file .path')).toHaveText(['README.md']);
  await expect(banner).toHaveCount(0);

  await p.evaluate((m) => window.postMessage(m, '*'),
    { type: 'changedFiles', hash: hs, files: [], gap: 0, error: "Selected commits are on different branches; can't combine" });
  await expect(banner).toHaveText("Selected commits are on different branches; can't combine");
  await expect(p.locator('.details .file')).toHaveCount(0);
  await expect(p.locator('.row')).toHaveCount(25); // the list stays; only the pane shows the error
  await p.screenshot({ path: 'test-results/screenshots/010-branches-banner.png' });
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

test('right-click on a row offers Checkout, which posts checkout(hash); double-click and multi-selection don\'t', async ({ page: p }) => {
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
  const posted = () => p.evaluate(() => (window as unknown as { posted: { type: string }[] }).posted);
  const checkouts = async () => (await posted()).filter((m) => m.type === 'checkout');
  const rows = p.locator('.row');
  const menu = p.locator('.menu');

  // Double-click selects but never checks out.
  await rows.nth(1).dblclick();
  await expect(rows.nth(1)).toHaveClass(/selected/);
  expect(await checkouts()).toEqual([]);

  // Right-click an unselected row: it becomes the single selection and the menu offers Checkout.
  await rows.nth(2).click({ button: 'right' });
  await expect(rows.nth(2)).toHaveClass(/selected/);
  await expect(menu.locator('.menu-item')).toHaveText(['Checkout']);
  await p.screenshot({ path: 'test-results/screenshots/011-context-menu.png' });
  await menu.locator('.menu-item').click();
  await expect(menu).toHaveCount(0);
  expect(await checkouts()).toEqual([{ type: 'checkout', hash: commits[2]!.hash }]);

  // Escape and clicking elsewhere close the menu without posting.
  await rows.nth(2).click({ button: 'right' });
  await p.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await rows.nth(2).click({ button: 'right' });
  await rows.nth(5).click();
  await expect(menu).toHaveCount(0);

  // Several selected: no Checkout.
  await rows.nth(6).click({ modifiers: ['Shift'] });
  await rows.nth(5).click({ button: 'right' });
  await expect(p.locator('.row.selected')).toHaveCount(2);
  await expect(menu).toHaveCount(0);
  expect(await checkouts()).toHaveLength(1);
});

test('a 50k-commit history renders only the visible rows and pages in more at the bottom, one request at a time', async ({ page: p }) => {
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  // Build the fixture in the page: `count` commits starting at index `skip`.
  const postPage = (skip: number, count: number) => p.evaluate(([skip, count]) => {
    const commits = Array.from({ length: count }, (_, k) => {
      const i = skip + k;
      return {
        hash: i.toString(16).padStart(8, '0').padEnd(40, 'a'), parents: [], subject: `Commit ${i}`, authorName: 'Alice',
        authorEmail: 'a@example.com', authorDate: '2024-01-01T00:00:00Z', refs: [],
      };
    });
    window.postMessage({ type: 'commits', skip, commits }, '*');
  }, [skip, count] as const);
  const loads = () => p.evaluate(() => (window as unknown as { posted: { type: string }[] }).posted.filter((m) => m.type === 'loadCommits'));
  const scrollTo = (top: number | 'bottom') => p.locator('.commits').evaluate((el, top) => {
    el.scrollTop = top === 'bottom' ? el.scrollHeight : top;
  }, top);
  const row = (i: number) => p.locator(`.row[data-index="${i}"]`);

  await postPage(0, 50_000);
  await expect(row(0).locator('.subject')).toHaveText('Commit 0');
  expect(await p.locator('.row').count()).toBeLessThan(200);

  await scrollTo(25_000 * 22);
  await expect(row(25_000)).toBeInViewport();
  expect(await p.locator('.row').count()).toBeLessThan(200);
  expect(await loads()).toEqual([{ type: 'loadCommits', skip: 0, limit: 1000 }]);
  await p.screenshot({ path: 'test-results/screenshots/003-mid-scroll.png' });

  // Scrolling around the end while the request is in flight doesn't send it again.
  for (const [top, visible] of [['bottom', 49_999], [49_900 * 22, 49_900], ['bottom', 49_999]] as const) {
    await scrollTo(top);
    await expect(row(visible)).toBeInViewport();
  }
  expect(await loads()).toEqual([
    { type: 'loadCommits', skip: 0, limit: 1000 },
    { type: 'loadCommits', skip: 50_000, limit: 1000 },
  ]);
  expect(await p.locator('.row').count()).toBeLessThan(200);

  // A full page appends and the next request continues from it.
  await postPage(50_000, 1000);
  await scrollTo('bottom');
  await expect(row(50_999).locator('.subject')).toHaveText('Commit 50999');
  expect((await loads()).at(-1)).toEqual({ type: 'loadCommits', skip: 51_000, limit: 1000 });

  // A short page means the end: no more requests.
  await postPage(51_000, 10);
  await scrollTo('bottom');
  await expect(row(51_009)).toBeInViewport();
  await scrollTo(0);
  await scrollTo('bottom');
  expect(await loads()).toHaveLength(3);
});

test('a refresh keeps the selected commits that still exist and the pane on them; the button and the refresh message reload', async ({ page: p }) => {
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  const postPage = (c: Commit[]) => p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 1000, commits: c }, '*'), c);
  const posted = () => p.evaluate(() => (window as unknown as { posted: unknown[] }).posted);
  const clearPosted = () => p.evaluate(() => { (window as unknown as { posted: unknown[] }).posted = []; });
  await postPage(commits);
  const rows = p.locator('.row');
  await rows.nth(2).click();
  const details = { ...commits[2]!, message: 'Commit number 2\n\nbody' };
  await p.evaluate((d) => window.postMessage({ type: 'details', details: d }, '*'), details);
  await p.evaluate((h) => window.postMessage({ type: 'changedFiles', hash: h, files: [{ status: 'M', path: 'a.txt', binary: false }] }, '*'), commits[2]!.hash);
  await expect(p.locator('.details .message-body')).toHaveText('body');

  // The refresh button and the extension's refresh message both reload the first page.
  await clearPosted();
  await p.locator('button.refresh').click();
  await p.evaluate(() => window.postMessage({ type: 'refresh' }, '*'));
  await expect.poll(posted).toEqual([{ type: 'loadCommits', skip: 0, limit: 1000 }, { type: 'loadCommits', skip: 0, limit: 1000 }]);

  // A new commit on top: the selected commit moved down one row and stays selected; the pane stays on it.
  await clearPosted();
  const newer = { ...commits[0]!, hash: `ff${commits[0]!.hash.slice(2)}`, subject: 'New commit' };
  await postPage([newer, ...commits]);
  await expect(p.locator('.row.selected')).toHaveCount(1);
  await expect(p.locator('.row.selected .subject')).toHaveText('Commit number 2');
  await expect(p.locator('.row[data-index="3"]')).toHaveClass(/selected/);
  await expect(p.locator('.details .message-body')).toHaveText('body');
  await expect(p.locator('.details .file .path')).toHaveText(['a.txt']);
  expect(await posted()).toEqual([]);
  await p.screenshot({ path: 'test-results/screenshots/008-refresh-kept.png' });
  // Down still moves from the selected row.
  await p.locator('.commits').focus();
  await p.keyboard.press('ArrowDown');
  await expect(p.locator('.row.selected .subject')).toHaveText('Commit number 3');

  // Multi-selection: one of two selected commits disappears, so the pane follows the one that's left.
  await p.locator('.row[data-index="5"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(p.locator('.row.selected')).toHaveCount(2);
  await clearPosted();
  await postPage(commits.filter((_, i) => i !== 4)); // drops "Commit number 4" (row 5 above)
  await expect(p.locator('.row.selected .subject')).toHaveText(['Commit number 3']);
  expect(await posted()).toEqual([
    { type: 'commitDetails', hash: commits[3]!.hash },
    { type: 'changedFiles', hash: commits[3]!.hash },
    { type: 'branchesContaining', hash: commits[3]!.hash },
  ]);

  // A page without the selected commit clears the selection and the pane.
  await clearPosted();
  await postPage(commits.filter((_, i) => i !== 3 && i !== 4));
  await expect(p.locator('.row.selected')).toHaveCount(0);
  await expect(p.locator('.details .info')).toBeEmpty();
  await expect(p.locator('.details .files')).toBeEmpty();
  expect(await posted()).toEqual([]);
});

test('a refresh after paging reloads every loaded commit in one request', async ({ page: p }) => {
  await p.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m) });
  });
  await p.goto(page);
  const many = Array.from({ length: 1500 }, (_, i) => ({ ...commits[0]!, hash: i.toString(16).padStart(40, '0'), subject: `C${i}` }));
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 1000, commits: c }, '*'), many.slice(0, 1000));
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 1000, limit: 1000, commits: c }, '*'), many.slice(1000));
  await p.evaluate(() => { (window as unknown as { posted: unknown[] }).posted = []; });
  await p.evaluate(() => window.postMessage({ type: 'refresh' }, '*'));
  await expect.poll(() => p.evaluate(() => (window as unknown as { posted: unknown[] }).posted))
    .toEqual([{ type: 'loadCommits', skip: 0, limit: 1500 }]);
  // One commit was dropped meanwhile: 1499 < limit 1500 means that's the end, so scrolling to the bottom asks for nothing.
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 1500, commits: c }, '*'), many.slice(1));
  await expect(p.locator('.spacer')).toHaveAttribute('style', /height: 32978px/);
  await p.locator('.commits').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(p.locator('.row[data-index="1498"]')).toBeVisible();
  expect(await p.evaluate(() => (window as unknown as { posted: unknown[] }).posted)).toEqual([{ type: 'loadCommits', skip: 0, limit: 1500 }]);
});

test('changed files show as a tree: folders expanded, chains merged, counts, collapsible by click and Enter', async ({ page: p }) => {
  await p.setViewportSize({ width: 1000, height: 500 });
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
    { status: 'M', path: 'src/core/git.ts', binary: false },
    { status: 'A', path: 'src/core/fileTree.ts', binary: false },
    { status: 'R', oldPath: 'src/webview/old.ts', path: 'src/webview/main.ts', binary: false },
    { status: 'A', path: 'assets/img/logo.png', binary: true },
    { status: 'M', path: 'README.md', binary: false },
  ];
  await p.evaluate(([h, f]) => window.postMessage({ type: 'changedFiles', hash: h, files: f }, '*'), [hash, files] as const);
  const folders = p.locator('.details .files .folder');
  await expect(folders.locator('.folder-name')).toHaveText(['assets/img', 'src', 'core', 'webview']);
  await expect(folders.locator('.count')).toHaveText(['1', '3', '2', '1']);
  expect(await folders.evaluateAll((els) => els.map((e) => e.getAttribute('aria-expanded')))).toEqual(['true', 'true', 'true', 'true']);
  const visible = p.locator('.details .file:visible .path');
  await expect(visible).toHaveText(['logo.png', 'fileTree.ts', 'git.ts', 'old.ts → main.ts', 'README.md']);
  // Deeper rows are indented further.
  const x = (loc: ReturnType<typeof p.locator>) => loc.locator('.path, .folder-name').first().evaluate((e) => e.getBoundingClientRect().left);
  const [src, core, git] = [await x(folders.nth(1)), await x(folders.nth(2)), await x(p.locator('.file', { hasText: 'git.ts' }))];
  expect(core).toBeGreaterThan(src);
  expect(git).toBeGreaterThan(core);
  await p.screenshot({ path: 'test-results/screenshots/016-tree.png' });

  // Click collapses a folder (its whole subtree hides), click again expands; Enter does the same.
  await folders.nth(2).click();
  await expect(folders.nth(2)).toHaveAttribute('aria-expanded', 'false');
  await expect(visible).toHaveText(['logo.png', 'old.ts → main.ts', 'README.md']);
  await folders.nth(1).focus();
  await p.keyboard.press('Enter');
  await expect(visible).toHaveText(['logo.png', 'README.md']);
  await expect(folders.locator('.folder-name:visible')).toHaveText(['assets/img', 'src']);
  await p.keyboard.press('Enter');
  await folders.nth(2).click();
  await expect(visible).toHaveText(['logo.png', 'fileTree.ts', 'git.ts', 'old.ts → main.ts', 'README.md']);

  // Folders open no diff; files inside the tree still do.
  await p.evaluate(() => { (window as unknown as { posted: unknown[] }).posted = []; });
  await folders.nth(1).click();
  await folders.nth(1).click();
  await p.locator('.file', { hasText: 'main.ts' }).click();
  await p.locator('.file', { hasText: 'git.ts' }).dblclick();
  expect(await p.evaluate(() => (window as unknown as { posted: unknown[] }).posted)).toEqual([
    { type: 'openDiff', hash, file: files[2], preview: true },
    { type: 'openDiff', hash, file: files[0], preview: true },
    { type: 'openDiff', hash, file: files[0], preview: true },
    { type: 'openDiff', hash, file: files[0], preview: false },
  ]);
});

test('files sit above the details; splitters resize the pane and the files, and their positions survive a reload', async ({ page: p }) => {
  await p.setViewportSize({ width: 1000, height: 500 });
  await p.addInitScript(() => {
    // Fake VS Code webview state: survives the reload like VS Code's does.
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => w.posted.push(m),
      getState: () => JSON.parse(sessionStorage.getItem('state') ?? 'null') ?? undefined,
      setState: (s: unknown) => sessionStorage.setItem('state', JSON.stringify(s)),
    });
  });
  await p.goto(page);
  const load = async () => {
    await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, commits: c }, '*'), commits);
    await p.locator('.row').nth(1).click();
    await p.evaluate((d) => window.postMessage({ type: 'details', details: d }, '*'), { ...commits[1]!, message: 'Commit number 1\n\nbody' });
    await p.evaluate((h) => window.postMessage({ type: 'changedFiles', hash: h, files: [{ status: 'M', path: 'src/a.txt', binary: false }] }, '*'), commits[1]!.hash);
    await expect(p.locator('.details .file')).toHaveCount(1);
  };
  await load();
  const box = async (sel: string) => (await p.locator(sel).boundingBox())!;
  // Files on top, splitter, then details; the vertical splitter sits between the list and the pane.
  const [files, hSplit, info] = [await box('.details .files'), await box('.splitter-horizontal'), await box('.details .info')];
  expect(files.y).toBeLessThan(hSplit.y);
  expect(hSplit.y).toBeLessThan(info.y);
  const [list, vSplit, pane] = [await box('.commits'), await box('.splitter-vertical'), await box('.details')];
  expect(list.x + list.width).toBeLessThanOrEqual(vSplit.x + vSplit.width);
  expect(vSplit.x).toBeLessThan(pane.x);
  expect(pane.width).toBeCloseTo(400, -1); // 40% default

  const drag = async (b: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
    const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + dx / 2, y + dy / 2);
    await p.mouse.move(x + dx, y + dy);
    await p.mouse.up();
  };
  await drag(vSplit, -200, 0);
  await drag(await box('.splitter-horizontal'), 0, -100);
  const after = { pane: (await box('.details')).width, files: (await box('.details .files')).height, list: (await box('.commits')).width };
  expect(after.pane).toBeCloseTo(pane.width + 200, -1);
  expect(after.files).toBeCloseTo(files.height - 100, -1);
  expect(after.list).toBeCloseTo(list.width - 200, -1);
  await p.screenshot({ path: 'test-results/screenshots/016-splitters.png' });
  expect(await p.evaluate(() => JSON.parse(sessionStorage.getItem('state')!))).toEqual({ paneWidth: after.pane, filesHeight: after.files });

  // Reload the view: the saved positions come back.
  await p.reload();
  await load();
  expect((await box('.details')).width).toBe(after.pane);
  expect((await box('.details .files')).height).toBe(after.files);
  // A saved size bigger than a smaller window still leaves room for the list and the details.
  await p.setViewportSize({ width: 500, height: 200 });
  expect((await box('.commits')).width).toBeGreaterThanOrEqual(140);
  expect((await box('.details .info')).height).toBeGreaterThanOrEqual(35);
});

test('the graph: each row draws its lines and node as inline SVG, colours follow lines, HEAD is a ring; paging and refresh keep it consistent', async ({ page: p }) => {
  await p.setViewportSize({ width: 1000, height: 300 });
  await p.goto(page);
  const at = (i: number, hash: string, parents: string[], subject: string, refs: string[] = []): Commit =>
    ({ ...commits[i]!, hash: hash.repeat(40), parents: parents.map((h) => h.repeat(40)), subject, refs });
  const history = [
    at(0, 'm', ['b', 'f'], 'Merge feature', ['HEAD -> refs/heads/main']),
    at(1, 'b', ['a'], 'On main'),
    at(2, 'f', ['a'], 'On feature', ['refs/heads/feature']),
    at(3, 'a', [], 'Root'),
  ];
  const [blue, orange] = ['#4c9be8', '#e8a33d']; // PALETTE[0], PALETTE[1]
  // Lane x centres 6 and 18 (12px lanes); row height 22, node centre at 11.
  const expected = [
    [['M6 11L6 22', blue], ['M6 11L18 22', orange]],
    [['M6 0L6 11', blue], ['M18 0L18 22', orange], ['M6 11L6 22', blue]],
    [['M6 0L6 22', blue], ['M18 0L18 11', orange], ['M18 11L18 22', orange]],
    [['M6 0L6 11', blue], ['M18 0L6 11', orange]],
  ];
  const drawn = () => p.locator('.row').evaluateAll((rows) => rows.map((r) =>
    [...r.querySelectorAll('.graph path')].map((e) => [e.getAttribute('d'), e.getAttribute('stroke')])));
  const nodes = () => p.locator('.row .graph circle').evaluateAll((els) => els.map((e) =>
    ({ cx: e.getAttribute('cx'), head: e.classList.contains('node-head'), fill: e.getAttribute('fill'), stroke: e.getAttribute('stroke'), paint: getComputedStyle(e).fill })));

  // Two pages: the feature line crosses the boundary in the same lane and colour.
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 2, commits: c }, '*'), history.slice(0, 2));
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 2, limit: 2, commits: c }, '*'), history.slice(2));
  await expect(p.locator('.row')).toHaveCount(4);
  expect(await drawn()).toEqual(expected);
  const n = await nodes();
  expect(n.map((x) => [x.cx, x.head])).toEqual([['6', true], ['6', false], ['18', false], ['6', false]]);
  // HEAD: a ring (lane-coloured stroke, background fill); others: filled dots in their lane's colour.
  expect(n[0]).toMatchObject({ stroke: blue, fill: null, paint: 'rgb(255, 255, 255)' });
  expect(n[2]).toMatchObject({ fill: orange });
  // The graph comes first in the row.
  expect(await p.locator('.row').first().evaluate((r) => r.firstElementChild!.getAttribute('class'))).toBe('graph');

  // A refresh with a new commit on top recomputes the graph: the old rows draw exactly as before.
  const top = at(4, 'c', ['m'], 'New on main', ['HEAD -> refs/heads/main']);
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 1000, commits: c }, '*'),
    [top, { ...history[0]!, refs: [] }, ...history.slice(1)]);
  await expect(p.locator('.row')).toHaveCount(5);
  expect((await drawn()).slice(1)).toEqual([[['M6 0L6 11', blue], ...expected[0]!], ...expected.slice(1)]);
  expect((await nodes()).map((x) => x.head)).toEqual([true, false, false, false, false]);

  // A wider fixture for the screenshot: crossing lines and an octopus merge.
  const wide = [
    at(0, '1', ['5', '2', '3'], 'Octopus merge', ['HEAD -> refs/heads/main']),
    at(1, '4', ['2'], 'Tip of topic', ['refs/remotes/origin/topic']),
    at(2, '2', ['6', '5'], 'Merge main into topic'),
    at(3, '3', ['6'], 'Fix on hotfix', ['tag: refs/tags/v2']),
    at(4, '5', ['6'], 'On main'),
    at(5, '6', [], 'Root'),
  ];
  await p.evaluate((c) => window.postMessage({ type: 'commits', skip: 0, limit: 1000, commits: c }, '*'), wide);
  await expect(p.locator('.row').first().locator('.subject')).toHaveText('Octopus merge');
  await p.screenshot({ path: 'test-results/screenshots/017-graph.png' });
});
