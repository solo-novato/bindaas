import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: false,
  workers: 1,
  use: {
    browserName:
      process.env.PLAYWRIGHT_BROWSER === 'webkit' ? 'webkit' : 'chromium',
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1440, height: 940 },
    // Optional browser overrides for machines with a preinstalled browser.
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_EXECUTABLE ??
        (process.env.PLAYWRIGHT_BROWSER === 'webkit'
          ? undefined
          : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE),
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
  },
  reporter: 'list',
});
