import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: env && { ...process.env, ...env } });
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
  /** Decorations as git prints them, e.g. `HEAD -> main`, `tag: v1`, `feature`. */
  refs: string[];
}

const LOG_FIELDS = ['%H', '%P', '%s', '%an', '%ae', '%aI', '%D'];

/** A page of `git log HEAD --branches` in git's default order (newest commit date first). */
export async function listCommits(cwd: string, { skip = 0, limit = 1000 } = {}): Promise<Commit[]> {
  const out = await git(cwd, [
    'log', '-z', `--format=${LOG_FIELDS.join('%x00')}`, `--skip=${skip}`, `--max-count=${limit}`, 'HEAD', '--branches', '--',
  ]);
  return parseLog(out);
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
