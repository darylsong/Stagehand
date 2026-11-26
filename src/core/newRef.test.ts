import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch, newBranch, newTag, refNameError } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const rev = async (ref: string) => (await repo.git('rev-parse', '--verify', ref)).trim();

it('newBranch creates the branch at the commit and checks it out, carrying uncommitted changes', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n', 'g.txt': 'g\n' } });
  await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'g.txt'), 'dirty\n');
  await newBranch(repo.dir, a, 'feature/x');
  expect(await currentBranch(repo.dir)).toBe('feature/x');
  expect(await rev('refs/heads/feature/x')).toBe(a);
  expect(await rev('HEAD')).toBe(a);
  expect(await readFile(join(repo.dir, 'g.txt'), 'utf8')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe(' M g.txt\n');
});

it('a refused switch leaves the branch created and HEAD where it was, and throws git\'s error', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  await expect(newBranch(repo.dir, a, 'blocked')).rejects.toThrow(/f\.txt/);
  expect(await rev('refs/heads/blocked')).toBe(a);
  expect(await currentBranch(repo.dir)).toBe('main');
  expect(await rev('HEAD')).toBe(b);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('dirty\n');
});

it('newTag creates a lightweight tag at the commit without moving HEAD', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.commit('B');
  await newTag(repo.dir, a, 'v1.0');
  expect((await repo.git('cat-file', '-t', 'refs/tags/v1.0')).trim()).toBe('commit'); // annotated would be 'tag'
  expect(await rev('refs/tags/v1.0')).toBe(a);
  expect(await currentBranch(repo.dir)).toBe('main');
});

it('refNameError rejects invalid and existing names; newBranch/newTag refuse them and create nothing', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.git('tag', 'v1', a);
  await repo.git('checkout', '-q', '-b', 'prev');
  await repo.git('checkout', '-q', 'main'); // so `@{-1}` expands to 'prev' under --branch
  await repo.git('branch', '-D', 'prev');
  for (const name of ['', 'a b', 'a..b', 'x~1', 'x^', 'x:y', 'end.', 'a.lock', '-x', 'with?', '@{-1}', 'x/']) {
    expect(await refNameError(repo.dir, 'branch', name), name).toBe('Not a valid branch name');
    expect(await refNameError(repo.dir, 'tag', name), name).toBe('Not a valid tag name');
  }
  expect(await refNameError(repo.dir, 'branch', 'main')).toBe("A branch named 'main' already exists");
  expect(await refNameError(repo.dir, 'tag', 'v1')).toBe("A tag named 'v1' already exists");
  // Branches and tags are separate namespaces.
  expect(await refNameError(repo.dir, 'branch', 'v1')).toBeUndefined();
  expect(await refNameError(repo.dir, 'tag', 'main')).toBeUndefined();
  expect(await refNameError(repo.dir, 'branch', 'feature/ok-1')).toBeUndefined();

  await expect(newBranch(repo.dir, a, 'main')).rejects.toThrow("A branch named 'main' already exists");
  await expect(newBranch(repo.dir, a, 'a b')).rejects.toThrow('Not a valid branch name');
  await expect(newTag(repo.dir, a, 'v1')).rejects.toThrow("A tag named 'v1' already exists");
  await expect(newTag(repo.dir, a, 'a..b')).rejects.toThrow('Not a valid tag name');
  expect((await repo.git('for-each-ref', '--format=%(refname)')).split('\n').filter(Boolean)).toEqual(['refs/heads/main', 'refs/tags/v1']);
});
