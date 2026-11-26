import { afterEach, expect, it } from 'vitest';
import { branchesContaining } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

it('lists local and remote-tracking branches that contain the commit, without remote HEAD or detached HEAD', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'feature');
  const b = await repo.commit('B');
  await repo.git('checkout', '-q', 'main');
  await repo.git('update-ref', 'refs/remotes/origin/main', a);
  await repo.git('update-ref', 'refs/remotes/origin/feature', b);
  await repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await repo.git('checkout', '-q', '--detach', b);

  expect((await branchesContaining(repo.dir, a)).sort()).toEqual(['feature', 'main', 'origin/feature', 'origin/main']);
  expect((await branchesContaining(repo.dir, b)).sort()).toEqual(['feature', 'origin/feature']);
  await expect(branchesContaining(repo.dir, '--all')).rejects.toThrow('Not a commit hash');
});
