import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHERRY_PICK_DIRTY, cherryPick, sequencerAbort, sequencerContinue, sequencerState } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const head = async () => (await repo.git('rev-parse', 'HEAD')).trim();
const log = async (n: number) => (await repo.git('log', `-${n}`, '--format=%B%x00')).split('\0\n').slice(0, n).map((m) => m.trim());

it('picks oldest first, one commit each with the original message and no -x line, whatever order the hashes come in', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'a.txt': 'a\n' } });
  await repo.git('checkout', '-q', '-b', 'side');
  // Committer dates run backwards, so date order would put C first; ancestry decides.
  const b = await repo.commit('B\n\nbody of B', { files: { 'f.txt': 'b\n' }, date: '2024-01-03T00:00:00Z' });
  const c = await repo.commit('C', { files: { 'f.txt': 'c\n' }, date: '2024-01-02T00:00:00Z' });
  await repo.git('checkout', '-q', 'main');
  expect(await cherryPick(repo.dir, [c, b])).toBeUndefined();
  expect(await log(3)).toEqual(['C', 'B\n\nbody of B', 'A']);
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('c\n');
  expect(await sequencerState(repo.dir)).toBeUndefined();
});

it('refuses a commit that is already in HEAD, touching nothing', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'side');
  const s = await repo.commit('S', { files: { 's.txt': 's\n' } });
  await repo.git('checkout', '-q', 'main');
  const before = await head();
  await expect(cherryPick(repo.dir, [s, a])).rejects.toThrow(`Can't cherry-pick: ${a.slice(0, 8)} is already in the current branch`);
  expect(await head()).toBe(before);
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('refuses with uncommitted changes, touching nothing', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  await repo.git('checkout', '-q', '-b', 'side');
  const b = await repo.commit('B', { files: { 'f.txt': 'b\n' } });
  await repo.git('checkout', '-q', 'main');
  const before = await head();
  await writeFile(join(repo.dir, 'f.txt'), 'dirty\n');
  await expect(cherryPick(repo.dir, [b])).rejects.toThrow(CHERRY_PICK_DIRTY);
  expect(await head()).toBe(before);
  expect(await repo.git('status', '--porcelain')).toBe(' M f.txt\n');
  expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('dirty\n');
});

/** main: A (f=a), M (f=m); side from A: B (g), C (f=c), D (h). Picking [B, C, D] applies B, then conflicts on C. */
async function conflicting() {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'f.txt': 'a\n' } });
  await repo.git('checkout', '-q', '-b', 'side');
  const b = await repo.commit('B', { files: { 'g.txt': 'g\n' } });
  const c = await repo.commit('C', { files: { 'f.txt': 'c\n' } });
  const d = await repo.commit('D', { files: { 'h.txt': 'h\n' } });
  await repo.git('checkout', '-q', 'main');
  const m = await repo.commit('M', { files: { 'f.txt': 'm\n' } });
  return { b, c, d, m };
}

it('a conflict mid-sequence stops at that commit with earlier picks committed; continue finishes it', async () => {
  const { b, c, d } = await conflicting();
  expect(await cherryPick(repo.dir, [d, c, b])).toBe(c);
  expect(await sequencerState(repo.dir)).toEqual({ op: 'cherry-pick', at: c });
  expect(await log(1)).toEqual(['B']);
  await expect(sequencerContinue(repo.dir)).rejects.toThrow(); // unresolved conflicts
  expect(await sequencerState(repo.dir)).toEqual({ op: 'cherry-pick', at: c });
  await writeFile(join(repo.dir, 'f.txt'), 'resolved\n');
  await repo.git('add', 'f.txt');
  expect(await sequencerContinue(repo.dir)).toBeUndefined();
  expect(await sequencerState(repo.dir)).toBeUndefined();
  expect((await log(4)).map((msg) => msg.split('\n')[0])).toEqual(['D', 'C', 'B', 'M']);
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('abort after a conflict restores the original HEAD (single commit: CHERRY_PICK_HEAD, no sequencer)', async () => {
  const { c, m } = await conflicting();
  expect(await cherryPick(repo.dir, [c])).toBe(c);
  expect(await sequencerState(repo.dir)).toEqual({ op: 'cherry-pick', at: c });
  await sequencerAbort(repo.dir);
  expect(await head()).toBe(m);
  expect(await sequencerState(repo.dir)).toBeUndefined();
  expect(await repo.git('status', '--porcelain')).toBe('');
});

it('abort after a mid-sequence conflict undoes the picks already made', async () => {
  const { b, c, m } = await conflicting();
  await cherryPick(repo.dir, [b, c]);
  expect(await head()).not.toBe(m);
  await sequencerAbort(repo.dir);
  expect(await head()).toBe(m);
  expect(await sequencerState(repo.dir)).toBeUndefined();
});

it('the state comes from the sequencer\'s pick line when CHERRY_PICK_HEAD is gone (conflict committed by hand)', async () => {
  const { b, c, d } = await conflicting();
  await cherryPick(repo.dir, [b, c, d]);
  await writeFile(join(repo.dir, 'f.txt'), 'resolved\n');
  await repo.git('add', 'f.txt');
  await repo.git('-c', 'core.editor=true', 'commit', '-q', '--no-edit');
  const state = await sequencerState(repo.dir);
  expect(state?.op).toBe('cherry-pick');
  expect(state && c.startsWith(state.at)).toBe(true);
  expect(await sequencerContinue(repo.dir)).toBeUndefined();
  expect(await sequencerState(repo.dir)).toBeUndefined();
  expect(await log(1)).toEqual(['D']);
});
