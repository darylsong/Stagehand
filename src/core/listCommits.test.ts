import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, listCommits } from './git';
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
  expect(byHash[b]?.refs).toEqual(['refs/heads/feature']);
  expect(byHash[m]?.refs).toEqual(['HEAD -> refs/heads/main']);
  expect(byHash[a]?.authorDate).toMatch(/^2024-01-01T00:00:00/);

  expect((await listCommits(repo.dir, { skip: 1, limit: 2 })).map((x) => x.hash)).toEqual([m, c]);
  expect((await listCommits(repo.dir, { skip: 4, limit: 10 })).map((x) => x.hash)).toEqual([a]);
});

it('gives branch, tag and detached-HEAD refs on the right commits', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.git('tag', 'v1');
  const b = await repo.commit('B');
  await repo.git('checkout', '-q', '-b', 'feature');
  const c = await repo.commit('C');
  await repo.git('checkout', '-q', 'main');
  await repo.git('checkout', '-q', '--detach', a);

  const refs = Object.fromEntries((await listCommits(repo.dir)).map((x) => [x.hash, x.refs]));
  expect(refs[a]).toEqual(['HEAD', 'tag: refs/tags/v1']); // bare `HEAD` = detached
  expect(refs[b]).toEqual(['refs/heads/main']);
  expect(refs[c]).toEqual(['refs/heads/feature']);

  await repo.git('checkout', '-q', 'feature');
  await repo.git('update-ref', 'refs/remotes/origin/feature', c);
  expect((await listCommits(repo.dir))[0]).toMatchObject({ hash: c, refs: ['HEAD -> refs/heads/feature', 'refs/remotes/origin/feature'] });
});

describe('error kinds', () => {
  let dir: string | undefined;
  afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

  it('a directory outside any repo is "not-repo"', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stagehand-norepo-'));
    // GIT_CEILING_DIRECTORIES stops git finding a repo above the temp dir.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir());
    try {
      await expect(listCommits(dir)).rejects.toMatchObject({ kind: 'not-repo', message: 'Not a git repository' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a fresh repo (unborn branch, git log HEAD fails) is "no-commits"', async () => {
    repo = await createTestRepo();
    await expect(listCommits(repo.dir)).rejects.toMatchObject({ kind: 'no-commits', message: 'Repository has no commits' });
  });

  it('git missing from PATH is "git-not-found"', async () => {
    repo = await createTestRepo();
    await repo.commit('A');
    vi.stubEnv('PATH', '');
    try {
      await expect(listCommits(repo.dir)).rejects.toMatchObject({ kind: 'git-not-found', message: 'git not found on PATH' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('any other failure is "git" with git\'s error text', async () => {
    repo = await createTestRepo();
    const a = await repo.commit('A');
    await repo.commit('B');
    // HEAD still resolves, but walking to the parent fails: a corrupt repo.
    await rm(join(repo.dir, '.git', 'objects', a.slice(0, 2), a.slice(2)));
    const err = await listCommits(repo.dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({ kind: 'git', message: expect.stringContaining(a) });
    expect((err as GitError).message).not.toContain('Command failed');
  });
});
