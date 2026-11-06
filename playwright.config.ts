import { defineConfig, devices } from '@playwright/test';

// Three projects:
//   webkit   – closest to the macOS app (WKWebView)
//   chromium – closest to the Windows app (WebView2)
//   real     – the real Rust engine through `balader serve` (network, slow)
const viewport = { width: 1200, height: 780 };
// The built-bundle server is only needed (and only possible after a build) for --project=prod.
const wantsProd = process.argv.some((a) => a === '--project=prod' || a === 'prod');

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:1420',
    viewport,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'npm run dev', url: 'http://localhost:1420', reuseExistingServer: true, timeout: 60_000 },
    // The built bundle (npm run build first), for the CSP check.
    ...(wantsProd ? [{ command: 'npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 60_000 }] : []),
  ],
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport, deviceScaleFactor: 1 }, testIgnore: [/real\.spec\.ts/, /prod\.spec\.ts/] },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 1 }, testIgnore: [/real\.spec\.ts/, /shots\.spec\.ts/, /prod\.spec\.ts/] },
    { name: 'prod', use: { ...devices['Desktop Safari'], viewport, baseURL: 'http://localhost:4173' }, testMatch: /prod\.spec\.ts/ },
    { name: 'real', use: { ...devices['Desktop Chrome'], viewport }, testMatch: /real\.spec\.ts/, timeout: 240_000 },
  ],
});
