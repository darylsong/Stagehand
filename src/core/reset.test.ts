import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch, reset, type ResetMode } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const rev = async (ref: string) => (await repo.git('rev-parse', '--verify', ref)).trim();
const read = (f: string) => readFile(join(repo.dir, f), 'utf8');

async function twoCommits() {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  return { a, b };
}

it('mixed moves the branch, unstages B\'s change and keeps the working tree', async () => {
  const { a } = await twoCommits();
  await reset(repo.dir, a, 'mixed');
  expect(await rev('refs/heads/main')).toBe(a);
  expect(await currentBranch(repo.dir)).toBe('main');
  expect(await repo.git('status', '--porcelain')).toBe(' M f.txt\n');
  expect(await read('f.txt')).toBe('b\n');
});

it('soft moves the branch and keeps B\'s change staged', async () => {
  const { a } = await twoCommits();
  await reset(repo.dir, a, 'soft');
  expect(await rev('refs/heads/main')).toBe(a);
  expect(await repo.git('status', '--porcelain')).toBe('M  f.txt\n');
  expect(await read('f.txt')).toBe('b\n');
});

it('keep moves the branch and updates the working tree, keeping unrelated local changes', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n', 'g.txt': 'g\n' } });
  await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'g.txt'), 'dirty\n');
  await reset(repo.dir, a, 'keep');
  expect(await rev('refs/heads/main')).toBe(a);
  expect(await read('f.txt')).toBe('a\n');
  expect(await read('g.txt')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe(' M g.txt\n');
});

it('keep refuses when a local change touches a file the reset would change, and touches nothing', async () => {
  const { a, b } = await twoCommits();
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  await repo.git('add', 'f.txt');
  await expect(reset(repo.dir, a, 'keep')).rejects.toThrow(/f\.txt/);
  expect(await rev('refs/heads/main')).toBe(b);
  expect(await read('f.txt')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe('M  f.txt\n');
});

it('resets to a commit that is not an ancestor of HEAD', async () => {
  const { a } = await twoCommits();
  await repo.git('checkout', '-q', '-b', 'side', a);
  const c = await repo.commit('C', { files: { 'c.txt': 'c\n' } });
  await repo.git('checkout', '-q', 'main');
  await reset(repo.dir, c, 'mixed');
  expect(await rev('refs/heads/main')).toBe(c);
  expect(await currentBranch(repo.dir)).toBe('main');
});

it('moves a detached HEAD and no branch', async () => {
  const { a, b } = await twoCommits();
  await repo.git('checkout', '-q', '--detach', b);
  await reset(repo.dir, a, 'soft');
  expect(await rev('HEAD')).toBe(a);
  expect(await currentBranch(repo.dir)).toBeUndefined();
  expect(await rev('refs/heads/main')).toBe(b);
});

it('rejects hard (and any other mode) without touching anything', async () => {
  const { a, b } = await twoCommits();
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  for (const mode of ['hard', 'merge', '']) {
    await expect(reset(repo.dir, a, mode as ResetMode)).rejects.toThrow(/Not a reset mode/);
  }
  expect(await rev('HEAD')).toBe(b);
  expect(await read('f.txt')).toBe('dirty\n');
});
