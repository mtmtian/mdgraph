import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

// macOS 27: Firefox launched from a terminal/agent exits with "Could not find profile folder"
// (TCC protects ~/Library/Application Support/Firefox). Pointing CFFIXED_USER_HOME at a writable
// directory avoids it. Must be set before Playwright spawns the browser.
process.env.CFFIXED_USER_HOME ??= path.join(here, 'test-results', 'cf-home');
fs.mkdirSync(process.env.CFFIXED_USER_HOME, { recursive: true });

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
