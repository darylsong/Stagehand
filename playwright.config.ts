import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'src/webview',
  testMatch: '*.spec.ts',
  use: { browserName: 'chromium' },
});
