import { afterEach, expect, it } from 'vitest';
import { combinedChanges } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('combines B and C of A→B→C→D: union of files, base = first parent of the oldest toucher, target = the newest', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'both.txt': '1\n', 'onlyC.txt': 'c\n', 'gone.txt': 'g\n' } });
  const b = await repo.commit('B', { files: { 'both.txt': '2\n', 'onlyB.txt': 'b\n', 'temp.txt': 't\n' } });
  await repo.git('rm', '-q', 'temp.txt', 'gone.txt');
  const c = await repo.commit('C', { files: { 'both.txt': '3\n', 'onlyC.txt': 'cc\n' } });
  await repo.commit('D', { files: { 'both.txt': '4\n', 'd.txt': 'd\n' } });

  const expected = [
    { status: 'M', path: 'both.txt', binary: false, base: a, target: c },
    { status: 'D', path: 'gone.txt', binary: false, base: b, target: c },
    { status: 'A', path: 'onlyB.txt', binary: false, base: a, target: b },
    { status: 'M', path: 'onlyC.txt', binary: false, base: b, target: c },
    // temp.txt: added in B, deleted in C -> omitted.
  ];
  expect(await combinedChanges(repo.dir, [c, b])).toEqual(expected);
  expect(await combinedChanges(repo.dir, [b, c])).toEqual(expected); // order of the selection doesn't matter
});

it('a root commit in the selection gives an added file with no base', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': '1\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': '2\n' } });
  expect(await combinedChanges(repo.dir, [b.slice(0, 8), a])).toEqual([{ status: 'A', path: 'f.txt', binary: false, target: b }]);
});

it('refuses commits on different branches and non-hex input', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'f');
  const f = await repo.commit('F', { files: { 'f.txt': 'f\n' } });
  await repo.git('checkout', '-q', 'main');
  const m = await repo.commit('M', { files: { 'm.txt': 'm\n' } });
  await expect(combinedChanges(repo.dir, [f, m])).rejects.toThrow("can't combine");
  await expect(combinedChanges(repo.dir, [m, 'HEAD~1'])).rejects.toThrow('Not a commit hash');
});
