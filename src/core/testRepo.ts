import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './git';

export interface CommitOptions {
  /** Files to write before committing, path -> content. Omit for an empty commit. */
  files?: Record<string, string>;
  /** Author/committer date (any format git accepts). Defaults to a fixed, increasing clock. */
  date?: string;
  author?: string;
}

export interface TestRepo {
  dir: string;
  git: (...args: string[]) => Promise<string>;
  /** Commits and returns the new commit's full hash. */
  commit: (message: string, options?: CommitOptions) => Promise<string>;
  /** Runs `git merge --no-ff` with a deterministic date; returns the merge commit hash. */
  merge: (branch: string, message?: string) => Promise<string>;
  dispose: () => Promise<void>;
}

/**
 * Creates a throwaway git repo in a temp dir. Script a history with commit/merge/git:
 *   await repo.commit('A'); await repo.git('checkout', '-q', '-b', 'f'); await repo.commit('B');
 *   await repo.git('checkout', '-q', 'main'); await repo.merge('f');
 * Call dispose() when done.
 */
export async function createTestRepo(initialBranch = 'main'): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'stagehand-'));
  const run = (...args: string[]) => git(dir, args);
  await run('init', '-q', '-b', initialBranch);
  await run('config', 'user.name', 'Test');
  await run('config', 'user.email', 'test@example.com');
  await run('config', 'commit.gpgsign', 'false');

  // ponytail: fixed clock, one minute per commit, so log order and hashes are deterministic.
  let tick = 0;
  const dateEnv = (date?: string, author = 'Test') => {
    const d = date ?? `2024-01-01T00:${String(tick++).padStart(2, '0')}:00Z`;
    return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d, GIT_AUTHOR_NAME: author };
  };
  const head = async () => (await run('rev-parse', 'HEAD')).trim();

  return {
    dir,
    git: run,
    commit: async (message, { files, date, author } = {}) => {
      for (const [path, content] of Object.entries(files ?? {})) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
      }
      if (files) await run('add', '--', ...Object.keys(files));
      await git(dir, ['commit', '-q', '--allow-empty', '-m', message], dateEnv(date, author));
      return head();
    },
    merge: async (branch, message = `Merge ${branch}`) => {
      await git(dir, ['merge', '-q', '--no-ff', '-m', message, branch], dateEnv());
      return head();
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
