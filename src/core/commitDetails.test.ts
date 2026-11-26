import { afterEach, expect, it } from 'vitest';
import { commitDetails } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('returns the full multi-line message and the parents of a merge', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('Subject line\n\nBody paragraph one,\nstill one.\n\n  Indented second paragraph.', { author: 'Alice' });
  await repo.git('checkout', '-q', '-b', 'feature');
  const b = await repo.commit('B');
  await repo.git('checkout', '-q', 'main');
  const c = await repo.commit('C');
  const m = await repo.merge('feature', 'Merge feature\n\nWhy we merged.');

  expect(await commitDetails(repo.dir, a)).toEqual({
    hash: a, parents: [], subject: 'Subject line', authorName: 'Alice', authorEmail: 'test@example.com',
    // git prints UTC as +00:00 (2.39) or Z (newer); both are fine.
    authorDate: expect.stringMatching(/^2024-01-01T00:00:00(Z|\+00:00)$/),
    message: 'Subject line\n\nBody paragraph one,\nstill one.\n\n  Indented second paragraph.',
  });
  const merge = await commitDetails(repo.dir, m);
  expect(merge.parents).toEqual([c, b]);
  expect(merge.message).toBe('Merge feature\n\nWhy we merged.');
  expect((await commitDetails(repo.dir, a.slice(0, 8))).hash).toBe(a);
});

it('rejects anything that is not a hex hash', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  await expect(commitDetails(repo.dir, '--output=/tmp/x')).rejects.toThrow('Not a commit hash');
  await expect(commitDetails(repo.dir, 'HEAD')).rejects.toThrow('Not a commit hash');
});
