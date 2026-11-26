import { afterEach, expect, it } from 'vitest';
import { fileAtRevision } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('returns the exact content at each revision, and empty where the path does not exist', async () => {
  repo = await createTestRepo();
  const before = await repo.commit('add', { files: { 'dir/a.txt': 'one\ntwo\n' } });
  const after = await repo.commit('modify', { files: { 'dir/a.txt': 'one\ntwo\nthree' } });
  expect(await fileAtRevision(repo.dir, before, 'dir/a.txt')).toBe('one\ntwo\n');
  expect(await fileAtRevision(repo.dir, after, 'dir/a.txt')).toBe('one\ntwo\nthree');
  expect(await fileAtRevision(repo.dir, before, 'missing.txt')).toBe('');
  expect(await fileAtRevision(repo.dir, before, 'dir/missing.txt')).toBe('');
});

it('rejects a revision that is not a hex hash', async () => {
  repo = await createTestRepo();
  await repo.commit('add', { files: { 'a.txt': 'a' } });
  await expect(fileAtRevision(repo.dir, 'HEAD', 'a.txt')).rejects.toThrow('Not a commit hash');
});

it('reads files larger than 1 MiB', async () => {
  repo = await createTestRepo();
  const big = 'x'.repeat(2_000_000);
  const rev = await repo.commit('big', { files: { 'big.txt': big } });
  expect(await fileAtRevision(repo.dir, rev, 'big.txt')).toBe(big);
});

it('returns empty for a missing path under a non-English locale', async () => {
  repo = await createTestRepo();
  const rev = await repo.commit('add', { files: { 'a.txt': 'a' } });
  const saved = { LANG: process.env.LANG, LANGUAGE: process.env.LANGUAGE, LC_ALL: process.env.LC_ALL };
  Object.assign(process.env, { LANG: 'C.UTF-8', LANGUAGE: 'de', LC_ALL: 'C.UTF-8' });
  try {
    expect(await fileAtRevision(repo.dir, rev, 'missing.txt')).toBe('');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
