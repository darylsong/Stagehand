import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { listCommits } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('three pages of 1000 with increasing skip return all 2,500 commits from two branch tips, in order, no repeats', async () => {
  repo = await createTestRepo();
  // fast-import: 2,500 commits in one process. main and feature interleave by date so pages mix both tips.
  let script = '';
  for (let i = 1; i <= 2500; i++) {
    const branch = i > 1 && i % 2 === 0 ? 'feature' : 'main';
    const from = i === 2 ? 'from :1\n' : '';
    const t = 1704067200 + i * 60;
    script += `commit refs/heads/${branch}\nmark :${i}\ncommitter T <t@example.com> ${t} +0000\ndata ${`c${i}`.length}\nc${i}\n${from}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo.dir, input: script });
  await repo.git('reset', '-q', '--hard', 'main');

  const pages = [];
  for (const skip of [0, 1000, 2000]) pages.push(await listCommits(repo.dir, { skip, limit: 1000 }));
  expect(pages.map((p) => p.length)).toEqual([1000, 1000, 500]);
  const hashes = pages.flat().map((c) => c.hash);
  expect(new Set(hashes).size).toBe(2500);
  expect(hashes).toEqual((await repo.git('log', '--format=%H', 'HEAD', '--branches')).trim().split('\n'));
  expect(pages[0]!.slice(0, 2).map((c) => c.subject)).toEqual(['c2500', 'c2499']);
});
