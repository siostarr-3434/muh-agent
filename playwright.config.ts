import { defineConfig, devices } from '@playwright/test'

const localBrowser = process.platform === 'win32' ? { channel: 'chrome' as const } : {}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...localBrowser } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], ...localBrowser } },
  ],
  webServer: {
    command: 'npm run preview:e2e',
    env: { MUH_AGENT_PORT: '4173' },
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
