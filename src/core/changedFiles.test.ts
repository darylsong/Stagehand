import { afterEach, expect, it } from 'vitest';
import { changedFiles } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

it('gives status, paths and binary flag for add, modify, delete, rename and binary add', async () => {
  repo = await createTestRepo();
  const root = await repo.commit('root', { files: { 'keep.txt': 'a\n', 'gone.txt': 'x\n', 'old/name.txt': text } });
  expect(await changedFiles(repo.dir, root)).toEqual([
    { status: 'A', path: 'gone.txt', binary: false },
    { status: 'A', path: 'keep.txt', binary: false },
    { status: 'A', path: 'old/name.txt', binary: false },
  ]);

  const modify = await repo.commit('modify', { files: { 'keep.txt': 'a\nb\n' } });
  expect(await changedFiles(repo.dir, modify)).toEqual([{ status: 'M', path: 'keep.txt', binary: false }]);

  await repo.git('rm', '-q', 'gone.txt');
  const del = await repo.commit('delete');
  expect(await changedFiles(repo.dir, del)).toEqual([{ status: 'D', path: 'gone.txt', binary: false }]);

  await repo.git('mv', 'old/name.txt', 'new name.txt');
  const rename = await repo.commit('rename', { files: { 'new name.txt': text + 'one more\n' } });
  expect(await changedFiles(repo.dir, rename)).toEqual([
    { status: 'R', oldPath: 'old/name.txt', path: 'new name.txt', binary: false },
  ]);

  const binary = await repo.commit('binary', { files: { 'img.bin': 'PNG\0\x01\x02', 'note.txt': 'n\n' } });
  expect(await changedFiles(repo.dir, binary)).toEqual([
    { status: 'A', path: 'img.bin', binary: true },
    { status: 'A', path: 'note.txt', binary: false },
  ]);
});

it('lists a merge against its first parent and an empty root commit as nothing', async () => {
  repo = await createTestRepo();
  const empty = await repo.commit('init');
  expect(await changedFiles(repo.dir, empty)).toEqual([]);
  await repo.git('checkout', '-q', '-b', 'feature');
  await repo.commit('F', { files: { 'feature.txt': 'f\n' } });
  await repo.git('checkout', '-q', 'main');
  await repo.commit('M', { files: { 'main.txt': 'm\n' } });
  const merge = await repo.merge('feature');
  // Against the first parent (main) the merge brought in feature.txt only.
  expect(await changedFiles(repo.dir, merge)).toEqual([{ status: 'A', path: 'feature.txt', binary: false }]);
});

it('rejects anything that is not a hex hash', async () => {
  repo = await createTestRepo();
  await expect(changedFiles(repo.dir, 'HEAD~1')).rejects.toThrow('Not a commit hash');
});
