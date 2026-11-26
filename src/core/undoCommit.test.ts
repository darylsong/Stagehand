import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch, isPushed, undoCommit } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const rev = async (ref: string) => (await repo.git('rev-parse', '--verify', ref)).trim();

it('moves the branch back one commit and keeps its changes staged', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n', 'g.txt': 'g\n' } });
  await undoCommit(repo.dir, b);
  expect(await rev('refs/heads/main')).toBe(a);
  expect(await currentBranch(repo.dir)).toBe('main');
  expect(await repo.git('status', '--porcelain')).toBe('M  f.txt\nA  g.txt\n');
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('b\n');
});

it('refuses a hash that is no longer HEAD, touching nothing', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  const c = await repo.commit('C', { files: { 'f.txt': 'c\n' } });
  await expect(undoCommit(repo.dir, b)).rejects.toThrow(`Can't undo: ${b.slice(0, 8)} is no longer HEAD`);
  expect(await rev('HEAD')).toBe(c);
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('refuses a merge and the root', async () => {
  repo = await createTestRepo();
  const root = await repo.commit('root', { files: { 'f.txt': 'a\n' } });
  await expect(undoCommit(repo.dir, root)).rejects.toThrow("Can't undo the root commit");
  expect(await rev('HEAD')).toBe(root);
  await repo.git('checkout', '-q', '-b', 'side');
  await repo.commit('side', { files: { 's.txt': 's\n' } });
  await repo.git('checkout', '-q', 'main');
  await repo.commit('main', { files: { 'm.txt': 'm\n' } });
  const merge = await repo.merge('side');
  await expect(undoCommit(repo.dir, merge)).rejects.toThrow("Can't undo a merge commit");
  expect(await rev('HEAD')).toBe(merge);
});

it('refuses a non-hex hash', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  await expect(undoCommit(repo.dir, 'HEAD')).rejects.toThrow('Not a commit hash');
});

it('isPushed: HEAD reachable from the upstream warns, a local-only HEAD does not', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  expect(await isPushed(repo.dir, a)).toBe(false); // no upstream
  await repo.git('remote', 'add', 'origin', 'https://example.invalid/r.git');
  await repo.git('update-ref', 'refs/remotes/origin/main', a);
  await repo.git('config', 'branch.main.remote', 'origin');
  await repo.git('config', 'branch.main.merge', 'refs/heads/main');
  expect(await isPushed(repo.dir, a)).toBe(true);
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  expect(await isPushed(repo.dir, b)).toBe(false);
});
