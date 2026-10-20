import { defineConfig, devices } from '@playwright/test';

// Тесты меняют общую учебную БД и сбрасывают её перед каждым тестом,
// поэтому выполняются строго последовательно.
export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
