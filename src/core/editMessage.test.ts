import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BRANCH_CHANGED, editMessage, isPushed } from './git';
import { createTestRepo, type TestRepo } from './testRepo';

let repo: TestRepo;
afterEach(() => repo?.dispose());
const rev = async (r: string) => (await repo.git('rev-parse', r)).trim();
/** tree, parents, author name/email/date and message of a commit, one per line. */
const show = async (r: string, f = '%T%n%P%n%an%n%ae%n%aI%n%B') => (await repo.git('show', '-s', `--format=${f}`, r)).trim();
const reflog = async (ref: string) => (await repo.git('reflog', '-1', '--format=%gs', ref)).trim();

it('rewords HEAD: same tree, parents and author; new message; committer date now; reflog names it', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  const b = await repo.commit('B', { files: { 'b.txt': 'b\n' }, author: 'Bea' });
  const fresh = await editMessage(repo.dir, b, 'B2\n\nbody line');
  expect(fresh).not.toBe(b);
  expect(await rev('main')).toBe(fresh);
  expect(await show(fresh)).toBe((await show(b)).replace(/B$/, 'B2\n\nbody line'));
  expect(await show(fresh, '%P')).toBe(a);
  expect(Number(await show(fresh, '%ct'))).toBeGreaterThan(Date.parse('2025-01-01') / 1000);
  expect(await reflog('main')).toBe(`stagehand: reword ${b.slice(0, 8)}`);
  expect((await repo.git('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/main');
});

it('rewords an older commit: descendants re-created with their trees, authors and messages; a merge in between kept', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  const b = await repo.commit('B', { files: { 'b.txt': 'b\n' } });
  await repo.git('checkout', '-q', '-b', 'side');
  const s = await repo.commit('S', { files: { 's.txt': 's\n' }, author: 'Sid' });
  await repo.git('checkout', '-q', 'main');
  const c = await repo.commit('C', { files: { 'c.txt': 'c\n' }, author: 'Cleo' });
  const m = await repo.merge('side');
  const d = await repo.commit('D', { files: { 'b.txt': 'b2\n' } });
  const oldLog = await repo.git('log', '--first-parent', '--format=%T %an %ae %aI %s', 'main');

  const fresh = await editMessage(repo.dir, b, 'B edited');
  const newLog = await repo.git('log', '--first-parent', '--format=%T %an %ae %aI %s', 'main');
  expect(newLog).toBe(oldLog.replace(/ B\n/, ' B edited\n'));
  // D → M(C', S') → C' → B' → A, and S' → B' (S branched off B, so it is re-created too).
  const [newD, newM, newC] = [await rev('main'), await rev('main~1'), await rev('main~2')];
  expect([newD, newM, newC].some((h) => [d, m, c].includes(h))).toBe(false);
  expect((await show(newM, '%P')).split(' ')).toEqual([newC, await rev('main~1^2')]);
  expect(await rev('main~1^2')).not.toBe(s);
  expect(await show('main~1^2', '%an %s')).toBe('Sid S');
  expect(await rev('main~3')).toBe(fresh);
  expect(await rev('main~1^2~1')).toBe(fresh);
  // Only HEAD's branch moved.
  expect(await rev('side')).toBe(s);
});

it('keeps a merge parent that isn\'t a descendant of the edited commit', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'side');
  const s = await repo.commit('S', { files: { 's.txt': 's\n' } });
  await repo.git('checkout', '-q', 'main');
  const b = await repo.commit('B', { files: { 'b.txt': 'b\n' } });
  await repo.merge('side');
  const fresh = await editMessage(repo.dir, b, 'B edited');
  expect((await show('main', '%P')).split(' ')).toEqual([fresh, s]);
  expect(await show('main', '%s')).toBe('Merge side');
});

it('works with detached HEAD: HEAD moves, no branch or tag does', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  const b = await repo.commit('B');
  const c = await repo.commit('C');
  await repo.git('tag', 'v1', c);
  await repo.git('checkout', '-q', '--detach', c);
  const fresh = await editMessage(repo.dir, b, 'B edited');
  expect(await rev('HEAD~1')).toBe(fresh);
  expect(await show('HEAD', '%s')).toBe('C');
  expect(await rev('main')).toBe(c);
  expect(await rev('v1')).toBe(c);
  expect(await reflog('HEAD')).toBe(`stagehand: reword ${b.slice(0, 8)}`);
  await expect(repo.git('symbolic-ref', '-q', 'HEAD')).rejects.toThrow();
});

it('leaves a dirty working tree and index untouched', async () => {
  repo = await createTestRepo();
  await repo.commit('A', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  const b = await repo.commit('B', { files: { 'a.txt': 'a2\n' } });
  await writeFile(join(repo.dir, 'a.txt'), 'unstaged\n');
  await writeFile(join(repo.dir, 'b.txt'), 'staged\n');
  await repo.git('add', 'b.txt');
  await writeFile(join(repo.dir, 'new.txt'), 'untracked\n');
  const status = await repo.git('status', '--porcelain');
  await editMessage(repo.dir, b, 'B edited');
  expect(await repo.git('status', '--porcelain')).toBe(status);
  expect(await readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('unstaged\n');
  expect((await repo.git('diff', '--cached', '--name-only')).trim()).toBe('b.txt');
  expect(await repo.git('show', ':b.txt')).toBe('staged\n');
});

it('moves no other branch or tag pointing at the old commits', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  const b = await repo.commit('B');
  await repo.git('branch', 'other', b);
  await repo.git('tag', 't', a);
  await editMessage(repo.dir, a, 'A edited');
  expect(await rev('other')).toBe(b);
  expect(await rev('t')).toBe(a);
  expect(await show('main~1', '%s')).toBe('A edited');
});

it('refuses with "the branch changed" when HEAD moved since it was read, writing no ref', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  const b = await repo.commit('B');
  const c = await repo.commit('C'); // HEAD moved on after the edit started at B
  const refs = await repo.git('for-each-ref');
  await expect(editMessage(repo.dir, b, 'B edited', b)).rejects.toThrow(BRANCH_CHANGED);
  expect(await rev('HEAD')).toBe(c);
  expect(await repo.git('for-each-ref')).toBe(refs);
  expect(await reflog('main')).not.toMatch(/stagehand/);
});

it('refuses a commit that isn\'t an ancestor of HEAD, and a non-hex hash', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  await repo.git('checkout', '-q', '-b', 'side');
  const s = await repo.commit('S');
  await repo.git('checkout', '-q', 'main');
  await expect(editMessage(repo.dir, s, 'x')).rejects.toThrow(`Can't edit: ${s.slice(0, 8)} isn't in the current branch`);
  await expect(editMessage(repo.dir, 'HEAD', 'x')).rejects.toThrow('Not a commit hash');
});

it('isPushed: reachable from the upstream; false for newer commits and without an upstream', async () => {
  repo = await createTestRepo();
  const a = await repo.commit('A');
  const b = await repo.commit('B');
  expect(await isPushed(repo.dir, a)).toBe(false); // no upstream
  await repo.git('update-ref', 'refs/remotes/origin/main', a);
  await repo.git('remote', 'add', 'origin', 'https://example.invalid/r.git');
  await repo.git('config', 'branch.main.remote', 'origin');
  await repo.git('config', 'branch.main.merge', 'refs/heads/main');
  expect(await isPushed(repo.dir, a)).toBe(true);
  expect(await isPushed(repo.dir, b)).toBe(false);
  await repo.git('checkout', '-q', '--detach', b);
  expect(await isPushed(repo.dir, a)).toBe(false); // detached: no upstream
});

it('keeps a descendant\'s message byte-for-byte, including its encoding header and non-UTF-8 bytes', async () => {
  repo = await createTestRepo();
  await repo.commit('A');
  const b = await repo.commit('B');
  // Leading spaces, blank lines and a Latin-1 "é" (0xE9), committed verbatim with an encoding header.
  const msgFile = join(repo.dir, '.git', 'STAGEHAND_TEST_MSG');
  await writeFile(msgFile, Buffer.from('  Caf\xe9 subject\n\n  body\n\n\n', 'latin1'));
  await repo.git('-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', msgFile);
  const catFile = (r: string) => execFileSync('git', ['cat-file', 'commit', r], { cwd: repo.dir, encoding: 'latin1' });
  const before = catFile('HEAD');
  await editMessage(repo.dir, b, 'B2');
  const after = catFile('HEAD');
  const body = (raw: string) => raw.slice(raw.indexOf('\n\n'));
  expect(body(after)).toBe(body(before));
  expect(body(after)).toBe('\n\n  Caf\xe9 subject\n\n  body\n\n\n');
  expect(after).toContain('\nencoding ISO-8859-1\n');
  expect(await show('HEAD~1', '%s')).toBe('B2');
});
