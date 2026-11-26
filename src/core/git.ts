import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, env: env && { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024, // ponytail: whole file in memory; stream if huge files matter
  });
  return stdout;
}

/** Current branch name, or undefined when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  return parseBranchHead(await git(cwd, ['status', '--porcelain=v2', '--branch']));
}

export function parseBranchHead(porcelainV2: string): string | undefined {
  const line = porcelainV2.split('\n').find((l) => l.startsWith('# branch.head '));
  const head = line?.slice('# branch.head '.length).trim();
  return head === undefined || head === '(detached)' ? undefined : head;
}

export interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Strict ISO 8601. */
  authorDate: string;
  /** Decorations with full refnames, e.g. `HEAD -> refs/heads/main`, `HEAD` (detached), `tag: refs/tags/v1`, `refs/remotes/origin/main`. */
  refs: string[];
}

const LOG_FIELDS = ['%H', '%P', '%s', '%an', '%ae', '%aI', '%D'];

export type ErrorKind = 'no-folder' | 'not-repo' | 'no-commits' | 'git-not-found' | 'git';

/** A failure the view shows as a state. `message` is plain text for the user; for kind 'git' it is git's error text. */
export class GitError extends Error {
  constructor(readonly kind: ErrorKind, message: string) {
    super(message);
  }
}

const STATE_TEXT: Record<Exclude<ErrorKind, 'git'>, string> = {
  'no-folder': 'No folder open',
  'not-repo': 'Not a git repository',
  'no-commits': 'Repository has no commits',
  'git-not-found': 'git not found on PATH',
};
export const gitError = (kind: Exclude<ErrorKind, 'git'>) => new GitError(kind, STATE_TEXT[kind]);

/** Turns a failed git call in `cwd` into a GitError, asking git (by exit code, not message text) why it failed. */
async function classify(cwd: string, err: unknown): Promise<GitError> {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  if (e.code === 'ENOENT') return gitError('git-not-found');
  try {
    await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch (probe) {
    // rev-parse exits 128 outside a repo and 1 when HEAD doesn't resolve (unborn branch).
    const code = (probe as { code?: unknown }).code;
    if (code === 128) return gitError('not-repo');
    if (code === 1) return gitError('no-commits');
  }
  return new GitError('git', e.stderr?.trim() || e.message || String(err));
}

/** A page of `git log HEAD --branches` in git's default order (newest commit date first). Throws GitError. */
export async function listCommits(cwd: string, { skip = 0, limit = 1000 } = {}): Promise<Commit[]> {
  try {
    const out = await git(cwd, [
      'log', '-z', `--format=${LOG_FIELDS.join('%x00')}`, `--skip=${skip}`, `--max-count=${limit}`, '--decorate=full', 'HEAD', '--branches', '--',
    ]);
    return parseLog(out);
  } catch (err) {
    throw await classify(cwd, err);
  }
}

/** Parses `git log -z` output whose fields are LOG_FIELDS joined by NUL. */
export function parseLog(out: string): Commit[] {
  const f = out.split('\0');
  const commits: Commit[] = [];
  for (let i = 0; i + LOG_FIELDS.length <= f.length; i += LOG_FIELDS.length) {
    const [hash = '', parents = '', subject = '', authorName = '', authorEmail = '', authorDate = '', refs = ''] = f.slice(i);
    commits.push({
      hash, subject, authorName, authorEmail, authorDate,
      parents: parents ? parents.split(' ') : [],
      refs: refs ? refs.split(', ') : [],
    });
  }
  return commits;
}

export interface CommitDetails extends Omit<Commit, 'refs'> {
  /** Full raw message: subject, blank line, body. */
  message: string;
}

/** One commit with its full message. `hash` must be a (possibly abbreviated) hex object name. */
export async function commitDetails(cwd: string, hash: string): Promise<CommitDetails> {
  // Trust boundary: the hash comes from the webview; refuse anything git could read as an option or rev expression.
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error(`Not a commit hash: ${hash}`);
  const out = await git(cwd, ['show', '-s', '--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%B', hash, '--']);
  const [h = '', parents = '', subject = '', authorName = '', authorEmail = '', authorDate = '', ...rest] = out.split('\0');
  return {
    hash: h, subject, authorName, authorEmail, authorDate,
    parents: parents ? parents.split(' ') : [],
    message: rest.join('\0').replace(/\n+$/, ''),
  };
}

export interface ChangedFile {
  /** A, M, D, R (rename score dropped), or another git status letter such as T. */
  status: string;
  path: string;
  /** Set for renames: the path before. */
  oldPath?: string;
  /** numstat reported `-`: git sees binary content. */
  binary: boolean;
  /** Combined lists only: the revisions the diff runs between (base undefined = the file starts empty). */
  base?: string;
  target?: string;
}

/** Files a commit changed: against its first parent, or everything as added for a root commit. Renames detected. */
export async function changedFiles(cwd: string, hash: string): Promise<ChangedFile[]> {
  // Trust boundary: firstParent rejects anything but a hex hash.
  return diffFiles(cwd, await firstParent(cwd, hash), hash);
}

async function diffFiles(cwd: string, parent: string | undefined, hash: string): Promise<ChangedFile[]> {
  const out = await git(cwd, [
    'diff-tree', '-r', '-M', '-z', '--raw', '--numstat', '--no-commit-id',
    ...(parent ? [parent, hash] : ['--root', hash]), '--',
  ]);
  return parseDiffTree(out);
}

/** Parses `git diff-tree -z --raw --numstat`: all raw records, then numstat records in the same order. */
export function parseDiffTree(out: string): ChangedFile[] {
  const f = out.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (f[i]?.startsWith(':')) {
    const status = f[i]!.split(' ').at(-1)!.charAt(0);
    if (status === 'R' || status === 'C') files.push({ status, oldPath: f[i + 1]!, path: f[i + 2]!, binary: false });
    else files.push({ status, path: f[i + 1]!, binary: false });
    i += status === 'R' || status === 'C' ? 3 : 2;
  }
  for (const file of files) {
    const stat = f[i] ?? '';
    // numstat: "added\tdeleted\tpath", or "added\tdeleted\t" followed by old and new paths for renames.
    file.binary = stat.startsWith('-\t-\t');
    i += stat.endsWith('\t') ? 3 : 1;
  }
  return files;
}

const hex = (h: string) => {
  if (!/^[0-9a-f]{4,64}$/i.test(h)) throw new Error(`Not a commit hash: ${h}`);
  return h;
};

/**
 * One combined file list for several commits on one line of history (each an ancestor of the newest).
 * Per file: base = first parent of the oldest selected commit that touched it, target = the newest one that did.
 * Files that don't exist at either end (added then deleted inside the selection) are omitted.
 */
/** combinedChanges' result: `gap` = unselected commits in between; `error` = why they can't be combined (files is then []). */
export type Combined = { files: ChangedFile[]; gap: number; error?: string };

export const DIFFERENT_BRANCHES = "Selected commits are on different branches; can't combine";

export async function combinedChanges(cwd: string, hashes: string[]): Promise<Combined> {
  hashes.forEach(hex);
  const tips = (await git(cwd, ['merge-base', '--independent', ...hashes])).trim().split('\n');
  if (tips.length !== 1) return { files: [], gap: 0, error: DIFFERENT_BRANCHES };
  const base = (await git(cwd, ['merge-base', '--octopus', ...hashes])).trim();
  const isSelected = (full: string) => hashes.some((h) => full.startsWith(h.toLowerCase()));
  // Newest first; children before parents. `^base` bounds the walk; base itself is added back if selected.
  const lines = (await git(cwd, ['rev-list', '--topo-order', '--parents', tips[0]!, `^${base}`, '--'])).trim().split('\n');
  const walked = lines.filter(Boolean).map((l) => l.split(' '));
  const ordered = walked.filter(([h]) => isSelected(h!));
  const gap = walked.length - ordered.length; // commits between base and tip that weren't selected
  if (isSelected(base)) ordered.push([base, ...(await git(cwd, ['show', '-s', '--format=%P', base, '--'])).trim().split(' ')]);

  const byPath = new Map<string, { first: string; firstStatus: string; firstParent?: string; last: string; lastStatus: string; binary: boolean; touches: number }>();
  for (const [hash, parent] of ordered.reverse()) { // oldest first
    for (const f of await diffFiles(cwd, parent || undefined, hash!)) {
      // ponytail: a rename counts as delete old + add new, so combined lists show no R; track renames if users miss them.
      const parts = f.oldPath && f.status === 'R' ? [{ path: f.oldPath, status: 'D' }, { path: f.path, status: 'A' }]
        : [{ path: f.path, status: f.status === 'C' ? 'A' : f.status }];
      for (const { path, status } of parts) {
        const e = byPath.get(path);
        if (e) Object.assign(e, { last: hash!, lastStatus: status, binary: e.binary || f.binary, touches: e.touches + 1 });
        else byPath.set(path, { first: hash!, firstStatus: status, firstParent: parent || undefined, last: hash!, lastStatus: status, binary: f.binary, touches: 1 });
      }
    }
  }
  const files: ChangedFile[] = [];
  for (const [path, e] of [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const before = e.firstStatus !== 'A';
    const after = e.lastStatus !== 'D';
    if (!before && !after) continue;
    const status = !before ? 'A' : !after ? 'D' : e.touches === 1 ? e.firstStatus : 'M';
    files.push({ status, path, binary: e.binary, ...(e.firstParent && { base: e.firstParent }), target: e.last });
  }
  return { files, gap };
}

/** First parent of a commit, or undefined for a root commit. `hash` must be a hex object name. */
export async function firstParent(cwd: string, hash: string): Promise<string | undefined> {
  // Trust boundary: hashes come from the webview; refuse anything git could read as an option or rev expression.
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error(`Not a commit hash: ${hash}`);
  return (await git(cwd, ['show', '-s', '--format=%P', hash, '--'])).trim().split(' ').filter(Boolean)[0];
}

/** Content of `path` at commit `rev` (`git show <rev>:<path>`), or '' when the path doesn't exist there. */
export async function fileAtRevision(cwd: string, rev: string, path: string): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(rev)) throw new Error(`Not a commit hash: ${rev}`);
  try {
    // LC_ALL=C: the stderr match below needs git's untranslated messages.
    return await git(cwd, ['show', `${rev}:${path}`], { LC_ALL: 'C' });
  } catch (err) {
    if (/does not exist in|exists on disk, but not in/.test((err as { stderr?: string }).stderr ?? '')) return '';
    throw err;
  }
}

/** What checking out `hash` means: the local branches whose tip it is (string[]), or the hash itself to detach at (string). */
export async function checkoutTarget(cwd: string, hash: string): Promise<string[] | string> {
  const branches = (await git(cwd, ['for-each-ref', `--points-at=${hex(hash)}`, '--format=%(refname:short)', 'refs/heads/']))
    .split('\n').filter(Boolean);
  return branches.length ? branches : hash;
}

/** A refused checkout. `localChanges`: git refused because uncommitted (or untracked) files would be overwritten. */
export class CheckoutRefused extends Error {
  constructor(message: string, readonly localChanges: boolean) {
    super(message);
  }
}

/** Plain `git checkout` (never forced) of a branch, or of a hash with HEAD detached. Throws CheckoutRefused with git's reason if it refuses. */
export async function checkout(cwd: string, target: { branch: string } | { detach: string }): Promise<void> {
  try {
    // LC_ALL=C: the "would be overwritten" match below needs git's untranslated messages.
    if ('branch' in target) await git(cwd, ['checkout', '-q', target.branch, '--'], { LC_ALL: 'C' });
    else await git(cwd, ['checkout', '-q', '--detach', hex(target.detach), '--'], { LC_ALL: 'C' });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const text = e.stderr?.trim() || e.message || String(err);
    throw new CheckoutRefused(text, /would be overwritten by checkout/.test(text));
  }
}

export const STASH_KEPT = 'Checked out, but your changes conflicted with it, so they were kept in stash (still in the stash list as stash@{0}).';

const topStash = async (cwd: string) => (await git(cwd, ['stash', 'list', '-n1', '--format=%H'])).trim();

/**
 * Stash (including untracked files), checkout, `stash pop`. Returns 'restored' when the changes applied cleanly,
 * 'kept in stash' when the pop conflicted (the entry stays in the stash list). Never discards uncommitted changes:
 * if the checkout itself fails, the stash is popped back onto the unchanged HEAD and the error rethrown.
 */
export async function smartCheckout(cwd: string, target: { branch: string } | { detach: string }): Promise<'restored' | 'kept in stash'> {
  const before = await topStash(cwd);
  await git(cwd, ['stash', 'push', '-q', '-u', '-m', 'stagehand: stash & checkout']);
  const stashed = (await topStash(cwd)) !== before; // nothing to save → no new entry; don't pop someone else's
  try {
    await checkout(cwd, target);
  } catch (err) {
    if (stashed) await git(cwd, ['stash', 'pop', '-q']);
    throw err;
  }
  if (!stashed) return 'restored';
  try {
    await git(cwd, ['stash', 'pop', '-q']);
    return 'restored';
  } catch {
    // git keeps the entry whenever pop fails.
    return 'kept in stash';
  }
}
