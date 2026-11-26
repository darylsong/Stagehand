import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localChanges } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

it('lists committed, staged, unstaged and untracked changes since the commit, renames detected, ignored files left out', async () => {
  repo = await createTestRepo();
  const base = await repo.commit('base', {
    files: { '.gitignore': '*.log\n', 'committed.txt': 'a\n', 'staged.txt': 'a\n', 'unstaged.txt': 'a\n', 'gone.txt': 'a\n', 'old.txt': text, 'same.txt': 'a\n' },
  });
  expect(await localChanges(repo.dir, base)).toEqual([]);

  await repo.commit('later', { files: { 'committed.txt': 'b\n', 'new-committed.txt': 'n\n' } });
  await writeFile(join(repo.dir, 'staged.txt'), 'b\n');
  await repo.git('add', 'staged.txt');
  await writeFile(join(repo.dir, 'unstaged.txt'), 'b\n');
  await unlink(join(repo.dir, 'gone.txt'));
  await repo.git('mv', 'old.txt', 'renamed.txt');
  await writeFile(join(repo.dir, 'untracked.txt'), 'u\n');
  await writeFile(join(repo.dir, 'untracked.bin'), 'PNG\0\x01');
  await writeFile(join(repo.dir, 'debug.log'), 'ignored\n');

  expect(await localChanges(repo.dir, base)).toEqual([
    { status: 'M', path: 'committed.txt', binary: false },
    { status: 'D', path: 'gone.txt', binary: false },
    { status: 'A', path: 'new-committed.txt', binary: false },
    { status: 'R', oldPath: 'old.txt', path: 'renamed.txt', binary: false },
    { status: 'M', path: 'staged.txt', binary: false },
    { status: 'M', path: 'unstaged.txt', binary: false },
    { status: 'A', path: 'untracked.bin', binary: true },
    { status: 'A', path: 'untracked.txt', binary: false },
  ]);
});

it('flags tracked binary changes and rejects anything that is not a hex hash', async () => {
  repo = await createTestRepo();
  const base = await repo.commit('base', { files: { 'img.bin': 'PNG\0\x01' } });
  await writeFile(join(repo.dir, 'img.bin'), 'PNG\0\x02');
  expect(await localChanges(repo.dir, base)).toEqual([{ status: 'M', path: 'img.bin', binary: true }]);
  await expect(localChanges(repo.dir, 'HEAD')).rejects.toThrow('Not a commit hash');
});
