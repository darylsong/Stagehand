import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REVERT_DIRTY, revert, revertAbort, revertContinue, revertState } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const head = async () => (await repo.git('rev-parse', 'HEAD')).trim();
const log = async (n: number) => (await repo.git('log', `-${n}`, '--format=%B%x00')).split('\0\n').slice(0, n).map((m) => m.trim());

it('reverts newest first, one commit each with git\'s message, whatever order the hashes come in', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'a.txt': 'a\n' } });
  // Committer dates run backwards, so date order would put B first; ancestry decides.
  const b = await repo.commit('B', { files: { 'b.txt': 'b\n' }, date: '2024-01-03T00:00:00Z' });
  const c = await repo.commit('C', { files: { 'c.txt': 'c\n' }, date: '2024-01-02T00:00:00Z' });
  expect(await revert(repo.dir, [b, c])).toBeUndefined();
  expect(await log(4)).toEqual([
    `Revert "B"\n\nThis reverts commit ${b}.`,
    `Revert "C"\n\nThis reverts commit ${c}.`,
    'C',
    'B',
  ]);
  expect((await repo.git('ls-files')).trim()).toBe('a.txt');
  expect(await revertState(repo.dir)).toBeUndefined();
});

it('refuses a commit that isn\'t an ancestor of HEAD, touching nothing', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'side');
  const s = await repo.commit('S', { files: { 's.txt': 's\n' } });
  await repo.git('checkout', '-q', 'main');
  const before = await head();
  await expect(revert(repo.dir, [s])).rejects.toThrow(`Can't revert: ${s.slice(0, 8)} isn't in the current branch`);
  expect(await head()).toBe(before);
});

it('refuses with uncommitted changes, touching nothing', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n', 'g.txt': 'g\n' } });
  await writeFile(join(repo.dir, 'g.txt'), 'dirty\n');
  await expect(revert(repo.dir, [b])).rejects.toThrow(REVERT_DIRTY);
  expect(await head()).toBe(b);
  expect(await readFile(join(repo.dir, 'g.txt'), 'utf8')).toBe('dirty\n');
  expect(await repo.git('status', '--porcelain')).toBe(' M g.txt\n');
});

/** A, H (h), B (f=b), C (f=c), D (g): reverting [B, D] reverts D, then conflicts on B. */
async function conflicting() {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  const h = await repo.commit('H', { files: { 'h.txt': 'h\n' } });
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await repo.commit('C', { files: { 'f.txt': 'c\n' } });
  const d = await repo.commit('D', { files: { 'g.txt': 'g\n' } });
  return { h, b, d };
}

it('a conflict mid-sequence stops at that commit with earlier reverts committed; continue finishes it', async () => {
  const { b, d } = await conflicting();
  expect(await revert(repo.dir, [b, d])).toBe(b);
  expect(await revertState(repo.dir)).toBe(b);
  expect((await log(1))[0]).toBe(`Revert "D"\n\nThis reverts commit ${d}.`);
  await expect(revertContinue(repo.dir)).rejects.toThrow(); // unresolved conflicts
  expect(await revertState(repo.dir)).toBe(b);
  await writeFile(join(repo.dir, 'f.txt'), 'resolved\n');
  await repo.git('add', 'f.txt');
  expect(await revertContinue(repo.dir)).toBeUndefined();
  expect(await revertState(repo.dir)).toBeUndefined();
  expect((await log(1))[0]).toMatch(new RegExp(`^Revert "B"\n\nThis reverts commit ${b}\\.`));
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('abort after a mid-sequence conflict restores the original HEAD', async () => {
  const { b, d } = await conflicting();
  await revert(repo.dir, [d, b]);
  expect(await revertState(repo.dir)).toBe(b);
  await revertAbort(repo.dir);
  expect(await head()).toBe(d);
  expect(await revertState(repo.dir)).toBeUndefined();
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('the banner state comes from the sequencer when REVERT_HEAD is gone (conflict committed by hand)', async () => {
  const { h, b, d } = await conflicting();
  await revert(repo.dir, [h, b, d]);
  await writeFile(join(repo.dir, 'f.txt'), 'resolved\n');
  await repo.git('add', 'f.txt');
  await repo.git('-c', 'core.editor=true', 'commit', '-q', '--no-edit');
  const at = await revertState(repo.dir); // the todo's first line: still the commit it stopped at
  expect(at && b.startsWith(at)).toBe(true);
  expect(await revertContinue(repo.dir)).toBeUndefined();
  expect(await revertState(repo.dir)).toBeUndefined();
  expect((await log(1))[0]).toBe(`Revert "H"\n\nThis reverts commit ${h}.`);
});
