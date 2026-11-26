import { afterEach, describe, expect, it } from 'vitest';
import { currentBranch, parseBranchHead } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());

describe('currentBranch', () => {
  it('returns the checked-out branch', async () => {
    repo = await createTestRepo('main');
    await repo.commit('init');
    await repo.git('checkout', '-q', '-b', 'feature/x');
    expect(await currentBranch(repo.dir)).toBe('feature/x');
  });

  it('works on an unborn branch', async () => {
    repo = await createTestRepo('fresh');
    expect(await currentBranch(repo.dir)).toBe('fresh');
  });

  it('returns undefined when detached', async () => {
    repo = await createTestRepo();
    await repo.commit('init');
    await repo.git('checkout', '-q', '--detach');
    expect(await currentBranch(repo.dir)).toBeUndefined();
  });
});

describe('parseBranchHead', () => {
  it('ignores other header lines', () => {
    expect(parseBranchHead('# branch.oid abc\n# branch.head dev\n# branch.upstream origin/dev\n')).toBe('dev');
  });
});

describe('createTestRepo', () => {
  it('scripts a branching history with files and merges', async () => {
    repo = await createTestRepo();
    await repo.commit('A', { files: { 'a.txt': 'a' } });
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.commit('B', { files: { 'dir/b.txt': 'b' }, author: 'Alice' });
    await repo.git('checkout', '-q', 'main');
    await repo.commit('C');
    await repo.merge('feature');
    const log = await repo.git('log', '--format=%s|%an|%p', '--topo-order');
    const lines = log.trim().split('\n').map((l) => l.split('|'));
    expect(lines.map(([s]) => s)).toEqual(['Merge feature', 'B', 'C', 'A']);
    expect(lines[1]?.[1]).toBe('Alice');
    expect(lines[0]?.[2]?.split(' ')).toHaveLength(2); // merge has two parents
  });
});
