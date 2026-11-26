import { afterEach, expect, it } from 'vitest';
import { listCommits } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('lists commits from HEAD and other local branches, newest first, with parents and refs', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'feature');
  const b = await repo.commit('B | with a pipe', { author: 'Alice' });
  await repo.git('checkout', '-q', 'main');
  const c = await repo.commit('C');
  const m = await repo.merge('feature');
  await repo.git('checkout', '-q', '-b', 'other', a);
  const d = await repo.commit('D on other');
  await repo.git('checkout', '-q', 'main');

  const commits = await listCommits(repo.dir);
  expect(commits.map((x) => x.hash)).toEqual([d, m, c, b, a]);
  const byHash = Object.fromEntries(commits.map((x) => [x.hash, x]));
  expect(byHash[m]?.parents).toEqual([c, b]);
  expect(byHash[a]?.parents).toEqual([]);
  expect(byHash[b]).toMatchObject({ subject: 'B | with a pipe', authorName: 'Alice', authorEmail: 'test@example.com', parents: [a] });
  expect(byHash[b]?.refs).toEqual(['feature']);
  expect(byHash[m]?.refs).toEqual(['HEAD -> main']);
  expect(byHash[a]?.authorDate).toMatch(/^2024-01-01T00:00:00/);

  expect((await listCommits(repo.dir, { skip: 1, limit: 2 })).map((x) => x.hash)).toEqual([m, c]);
  expect((await listCommits(repo.dir, { skip: 4, limit: 10 })).map((x) => x.hash)).toEqual([a]);
});
