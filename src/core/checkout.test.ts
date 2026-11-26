import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkout, checkoutTarget, currentBranch } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('checkoutTarget gives the branch for a tip, all branches for a shared tip, and the hash otherwise', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  const b = await repo.commit('B');
  await repo.git('branch', 'feature', a);
  await repo.git('branch', 'also-main', b);
  await repo.git('tag', 'v1', b);
  expect(await checkoutTarget(repo.dir, a)).toEqual(['feature']);
  expect(await checkoutTarget(repo.dir, b)).toEqual(['also-main', 'main']);
  await repo.git('branch', '-D', 'feature');
  expect(await checkoutTarget(repo.dir, a)).toBe(a);
  await expect(checkoutTarget(repo.dir, '--all')).rejects.toThrow('Not a commit hash');
});

it('checking out a branch attaches HEAD to it; checking out a non-tip leaves HEAD detached at that hash', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.commit('B');
  await checkout(repo.dir, { detach: a });
  expect(await currentBranch(repo.dir)).toBeUndefined();
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(a);
  await checkout(repo.dir, { branch: 'main' });
  expect(await currentBranch(repo.dir)).toBe('main');
});

it('a refused checkout throws git\'s reason and leaves HEAD and the working tree unchanged', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  await expect(checkout(repo.dir, { detach: a })).rejects.toThrow(/f\.txt/);
  expect(await currentBranch(repo.dir)).toBe('main');
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(b);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe(' M f.txt\n');
});
