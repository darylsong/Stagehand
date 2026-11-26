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
