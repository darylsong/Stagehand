import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkout, checkoutTarget, currentBranch, smartCheckout } from './git';
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
  await expect(checkout(repo.dir, { detach: a })).rejects.toMatchObject({ message: expect.stringMatching(/f\.txt/), localChanges: true });
  expect(await currentBranch(repo.dir)).toBe('main');
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(b);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe(' M f.txt\n');
});

it('a refusal for another reason is not flagged as local changes', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.commit('B');
  await writeFile(join(repo.dir, '.git', 'index.lock'), '');
  await expect(checkout(repo.dir, { detach: a })).rejects.toMatchObject({ localChanges: false });
});

it('smartCheckout re-applies changes that apply cleanly after the checkout, untracked files included', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': '1-a\n2\n3\n4\n5\n6\n' } });
  await repo.commit('B', { files: { 'f.txt': '1\n2\n3\n4\n5\n6\n' } });
  await writeFile(join(repo.dir, 'f.txt'), '1\n2\n3\n4\n5\n6-dirty\n');
  await writeFile(join(repo.dir, 'new.txt'), 'untracked\n');
  await expect(checkout(repo.dir, { detach: a })).rejects.toMatchObject({ localChanges: true });
  expect(await smartCheckout(repo.dir, { detach: a })).toBe('restored');
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(a);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('1-a\n2\n3\n4\n5\n6-dirty\n');
  expect(await readFile(join(repo.dir, 'new.txt'), 'utf8')).toBe('untracked\n');
  expect(await repo.git('stash', 'list')).toBe('');
});

it('smartCheckout keeps the stash when the changes conflict with the target', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  expect(await smartCheckout(repo.dir, { detach: a })).toBe('kept in stash');
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(a);
  expect(await repo.git('stash', 'list')).toMatch(/stagehand: stash & checkout/);
  expect(await repo.git('show', 'stash@{0}:f.txt')).toBe('dirty\n');
});

it('smartCheckout puts the changes back when the checkout fails, and never pops an older stash', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'f.txt'), 'older\n');
  await repo.git('stash', 'push', '-q', '-m', 'older');
  // Clean tree: nothing is stashed, so the older entry must stay where it is.
  expect(await smartCheckout(repo.dir, { branch: 'main' })).toBe('restored');
  expect(await repo.git('stash', 'list', '--format=%s')).toMatch(/older/);
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  await expect(smartCheckout(repo.dir, { branch: 'no-such-branch' })).rejects.toThrow();
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(b);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('dirty\n');
  expect((await repo.git('stash', 'list')).trim().split('\n')).toHaveLength(1);
});

it('smartCheckout stashes untracked files that block the checkout', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'u.txt': 'tracked in A\n' } });
  await repo.git('rm', '-q', 'u.txt');
  await repo.git('commit', '-q', '-m', 'B');
  await writeFile(join(repo.dir, 'u.txt'), 'untracked\n');
  await expect(checkout(repo.dir, { detach: a })).rejects.toMatchObject({ localChanges: true });
  expect(await smartCheckout(repo.dir, { detach: a })).toBe('kept in stash');
  expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(a);
  expect(await repo.git('show', 'stash@{0}^3:u.txt')).toBe('untracked\n');
});
