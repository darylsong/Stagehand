import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const page = pathToFileURL(resolve('out/webview/index.html')).href;

test('renders the branch it is sent', async ({ page: p }) => {
  await p.goto(page);
  await p.evaluate(() => window.postMessage({ branch: 'feature/log' }, '*'));
  await expect(p.locator('#branch')).toHaveText('feature/log');
  // Saved for the agent to Read and inspect visually.
  await p.screenshot({ path: 'test-results/screenshots/branch.png' });
});
